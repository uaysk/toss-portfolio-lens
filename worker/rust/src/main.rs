use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use portfolio_lens_compute::compute;
use portfolio_lens_compute::contracts::{
    JobKind, OutputArtifact, WorkerInput, WorkerOutput, job_kind,
};
use portfolio_lens_compute::control::ComputeControl;
use portfolio_lens_compute::repository::{
    JobClaim, WorkerRepository, epoch_ms, require_database_url, require_valid_worker_engine,
    worker_error,
};
use serde_json::{Value, json};

const MAX_SOCKET_FRAME_BYTES: usize = 128 * 1024 * 1024;
const SOCKET_PEER_CHECK_INTERVAL: usize = 32;
const SOCKET_HEALTH_TIMEOUT: Duration = Duration::from_secs(1);
const DEFAULT_SOCKET_MAX_ACTIVE: usize = 2;
const DEFAULT_SOCKET_MAX_CONNECTIONS: usize = 34;
const MAX_SOCKET_ADMISSION_LIMIT: usize = 4_096;

#[derive(Debug)]
struct Admission {
    limit: usize,
    active: Mutex<usize>,
    available: Condvar,
}

impl Admission {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            active: Mutex::new(0),
            available: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> AdmissionPermit {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while *active >= self.limit {
            active = self
                .available
                .wait(active)
                .unwrap_or_else(|error| error.into_inner());
        }
        *active += 1;
        AdmissionPermit {
            admission: self.clone(),
        }
    }

    fn try_acquire(self: &Arc<Self>) -> Option<AdmissionPermit> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *active >= self.limit {
            return None;
        }
        *active += 1;
        Some(AdmissionPermit {
            admission: self.clone(),
        })
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        *self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

struct AdmissionPermit {
    admission: Arc<Admission>,
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut active = self
            .admission
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *active = active.saturating_sub(1);
        self.admission.available.notify_one();
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ServeOptions {
    socket_path: String,
    max_active: usize,
    max_connections: usize,
}

fn peak_process_rss_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the supplied rusage value on success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: the successful call above initialized `usage`.
    let usage = unsafe { usage.assume_init() };
    #[cfg(target_os = "macos")]
    return u64::try_from(usage.ru_maxrss).ok();
    #[cfg(not(target_os = "macos"))]
    return u64::try_from(usage.ru_maxrss)
        .ok()
        .and_then(|value| value.checked_mul(1_024));
}

#[derive(Clone)]
struct Settings {
    database_url: String,
    worker_id: String,
    lease_ms: i64,
    heartbeat_ms: u64,
    poll_ms: u64,
    recovery_ms: u64,
}

impl Settings {
    fn from_env() -> Result<Self> {
        let lease_ms = env_i64("WORKER_LEASE_MS", 30_000).clamp(5_000, 600_000);
        let heartbeat_ms =
            env_u64("WORKER_HEARTBEAT_MS", 5_000).clamp(500, (lease_ms as u64 / 2).max(500));
        Ok(Self {
            database_url: require_database_url()?,
            worker_id: std::env::var("WORKER_ID")
                .unwrap_or_else(|_| format!("rust-{}", std::process::id())),
            lease_ms,
            heartbeat_ms,
            poll_ms: env_u64("WORKER_POLL_MS", 250).clamp(10, 60_000),
            recovery_ms: env_u64("WORKER_RECOVERY_MS", 10_000).clamp(1_000, 600_000),
        })
    }
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn env_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn read_stdin_json() -> Result<Value> {
    let mut source = Vec::new();
    std::io::stdin().read_to_end(&mut source)?;
    serde_json::from_slice(&source).context("stdin must contain one JSON value")
}

fn write_json(value: &impl serde::Serialize) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn direct(kind: JobKind) -> Result<()> {
    let value = read_stdin_json()?;
    let input: WorkerInput = serde_json::from_value(value)?;
    input.validate()?;
    if input.job_kind != kind {
        bail!("compute-json job kind does not match the worker payload");
    }
    let output = compute::compute(&input)?;
    write_json(&output)
}

fn parse_socket_input(value: Value) -> Result<WorkerInput> {
    let input: WorkerInput = serde_json::from_value(value)?;
    input.validate()?;
    Ok(input)
}

fn read_socket_frame(stream: &mut UnixStream) -> Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    match stream.read(&mut header[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    stream.read_exact(&mut header[1..])?;
    let frame_size = u32::from_be_bytes(header) as usize;
    if frame_size == 0 || frame_size > MAX_SOCKET_FRAME_BYTES {
        bail!("socket frame size is invalid: {frame_size}");
    }
    let mut source = vec![0_u8; frame_size];
    stream.read_exact(&mut source)?;
    Ok(Some(source))
}

fn encode_socket_frame(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    let source = serde_json::to_vec(value)?;
    if source.len() > MAX_SOCKET_FRAME_BYTES {
        bail!("socket response exceeds 128 MiB");
    }
    if source.len() > u32::MAX as usize {
        bail!("socket response exceeds frame length field");
    }
    Ok(source)
}

fn write_socket_bytes(stream: &mut UnixStream, source: &[u8]) -> Result<()> {
    stream.write_all(&(source.len() as u32).to_be_bytes())?;
    stream.write_all(source)?;
    stream.flush()?;
    Ok(())
}

#[cfg(test)]
fn write_socket_frame(stream: &mut UnixStream, value: &impl serde::Serialize) -> Result<()> {
    let source = encode_socket_frame(value)?;
    write_socket_bytes(stream, &source)
}

struct SocketControl {
    fd: RawFd,
    checkpoints: AtomicUsize,
    interval: usize,
}

impl SocketControl {
    fn new(fd: RawFd) -> Self {
        Self {
            fd,
            checkpoints: AtomicUsize::new(0),
            interval: SOCKET_PEER_CHECK_INTERVAL,
        }
    }

    #[cfg(test)]
    fn with_interval(fd: RawFd, interval: usize) -> Self {
        Self {
            fd,
            checkpoints: AtomicUsize::new(0),
            interval: interval.max(1),
        }
    }
}

impl ComputeControl for SocketControl {
    fn checkpoint(&self) -> Result<()> {
        let checkpoint = self.checkpoints.fetch_add(1, Ordering::Relaxed);
        if !checkpoint.is_multiple_of(self.interval) {
            return Ok(());
        }
        let mut byte = 0_u8;
        // SAFETY: `fd` belongs to the live `UnixStream` in `handle_socket`; MSG_PEEK does
        // not consume a pipelined next frame, and MSG_DONTWAIT prevents the checkpoint
        // from blocking when the peer is connected but has no pending bytes.
        let received = unsafe {
            libc::recv(
                self.fd,
                (&mut byte as *mut u8).cast::<libc::c_void>(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if received == 0 {
            bail!("RUST_COMPUTE_CLIENT_DISCONNECTED");
        }
        if received < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) {
                return Ok(());
            }
            bail!("RUST_COMPUTE_SOCKET_STATE_FAILED: {error}");
        }
        Ok(())
    }
}

fn handle_socket_with_admission(
    mut stream: UnixStream,
    active_admission: Option<Arc<Admission>>,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.set_write_timeout(Some(Duration::from_secs(300)))?;
    while let Some(source) = read_socket_frame(&mut stream)? {
        let started = Instant::now();
        let response = (|| -> Result<WorkerOutput> {
            let value: Value =
                serde_json::from_slice(&source).context("invalid framed JSON request")?;
            let requested_artifacts = value
                .get("include_artifacts")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let input = parse_socket_input(value)?;
            let include_artifacts = requested_artifacts
                && input.projection
                    == portfolio_lens_compute::contracts::WorkerResultProjection::Full;
            let compute_started = Instant::now();
            let control = SocketControl::new(stream.as_raw_fd());
            let active_permit = active_admission.as_ref().map(Admission::acquire);
            let output = compute::compute_with_control(&input, include_artifacts, Some(&control));
            drop(active_permit);
            let mut output = output?;
            let compute_ms = compute_started.elapsed().as_secs_f64() * 1000.0;
            output
                .artifacts
                .get_or_insert_with(Vec::new)
                .push(OutputArtifact {
                    artifact_type: "worker-metrics".into(),
                    content: json!({
                        "request_decode_ms": compute_started.duration_since(started).as_secs_f64() * 1000.0,
                        "compute_ms": compute_ms,
                        "peak_process_rss_bytes": peak_process_rss_bytes(),
                        "worker_elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
                        "engine": portfolio_lens_compute::ENGINE_VERSION,
                        "ipc": "unix_domain_socket_length_frame_v2",
                        "cancellation": "peer_disconnect_cooperative_checkpoints",
                    }),
                    row_count: Some(1),
                });
            Ok(output)
        })();
        match response {
            Ok(output) => {
                let source = encode_socket_frame(&output)?;
                write_socket_bytes(&mut stream, &source)?;
            }
            Err(error) => {
                let source = encode_socket_frame(&json!({
                    "status": "failed",
                    "error": {"code":"RUST_COMPUTE_FAILED", "message": error.to_string(), "retryable": false},
                }))?;
                write_socket_bytes(&mut stream, &source)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn handle_socket(stream: UnixStream) -> Result<()> {
    handle_socket_with_admission(stream, None)
}

fn serve(options: &ServeOptions) -> Result<()> {
    let socket_path = options.socket_path.as_str();
    let path = Path::new(socket_path);
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.file_type().is_socket() {
            bail!("refusing to replace non-socket path: {socket_path}");
        }
        fs::remove_file(path)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let listener =
        UnixListener::bind(path).with_context(|| format!("bind Unix socket {socket_path}"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
    eprintln!(
        "portfolio-lens Rust compute listening on {socket_path} (max-active={}, max-connections={})",
        options.max_active, options.max_connections
    );
    let active_admission = Arc::new(Admission::new(options.max_active));
    let connection_admission = Arc::new(Admission::new(options.max_connections));
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let Some(connection_permit) = connection_admission.try_acquire() else {
                    eprintln!("socket connection rejected: max-connections reached");
                    drop(stream);
                    continue;
                };
                let active_admission = active_admission.clone();
                thread::spawn(move || {
                    let _connection_permit = connection_permit;
                    if let Err(error) = handle_socket_with_admission(stream, Some(active_admission))
                    {
                        eprintln!("socket request failed: {error:#}");
                    }
                });
            }
            Err(error) => eprintln!("socket accept failed: {error}"),
        }
    }
    Ok(())
}

fn string_arg<'a>(args: &'a [String], name: &str, command: &str) -> Result<&'a str> {
    let index = args
        .iter()
        .position(|value| value == name)
        .with_context(|| format!("{command} requires {name} <value>"))?;
    let value = args
        .get(index + 1)
        .with_context(|| format!("{command} requires {name} <value>"))?;
    if value.starts_with("--") {
        bail!("{command} requires {name} <value>");
    }
    Ok(value)
}

fn socket_path_arg<'a>(args: &'a [String], command: &str) -> Result<&'a str> {
    string_arg(args, "--socket", command)
        .map_err(|_| anyhow::anyhow!("{command} requires --socket <path>"))
}

fn optional_bounded_usize_arg(args: &[String], name: &str, fallback: usize) -> Result<usize> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(fallback);
    };
    let raw = args
        .get(index + 1)
        .with_context(|| format!("{name} requires a positive integer"))?;
    if raw.starts_with("--") {
        bail!("{name} requires a positive integer");
    }
    let value = raw
        .parse::<usize>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 || value > MAX_SOCKET_ADMISSION_LIMIT {
        bail!("{name} must be in 1..={MAX_SOCKET_ADMISSION_LIMIT}");
    }
    Ok(value)
}

fn serve_options(args: &[String]) -> Result<ServeOptions> {
    let max_active = optional_bounded_usize_arg(args, "--max-active", DEFAULT_SOCKET_MAX_ACTIVE)?;
    let max_connections =
        optional_bounded_usize_arg(args, "--max-connections", DEFAULT_SOCKET_MAX_CONNECTIONS)?;
    if max_connections < max_active {
        bail!("--max-connections must be greater than or equal to --max-active");
    }
    Ok(ServeOptions {
        socket_path: socket_path_arg(args, "serve")?.to_owned(),
        max_active,
        max_connections,
    })
}

fn socket_health_with_timeout(socket_path: &str, timeout: Duration) -> Result<()> {
    let path = Path::new(socket_path).to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| -> Result<()> {
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("inspect Unix socket {}", path.display()))?;
            if !metadata.file_type().is_socket() {
                bail!("health target is not a Unix socket: {}", path.display());
            }
            UnixStream::connect(&path)
                .with_context(|| format!("connect Unix socket {}", path.display()))?;
            Ok(())
        })();
        let _ = sender.send(result);
    });

    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            bail!(
                "Unix socket health check timed out after {} ms: {socket_path}",
                timeout.as_millis()
            )
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            bail!("Unix socket health check worker disconnected: {socket_path}")
        }
    }
}

fn socket_health(socket_path: &str) -> Result<()> {
    socket_health_with_timeout(socket_path, SOCKET_HEALTH_TIMEOUT)
}

struct LeaseState {
    stop: AtomicBool,
    lost: AtomicBool,
    cancelled: AtomicBool,
    deadline: AtomicBool,
    deadline_at: i64,
}

impl ComputeControl for LeaseState {
    fn checkpoint(&self) -> Result<()> {
        if self.lost.load(Ordering::Acquire) {
            bail!("RUST_COMPUTE_LEASE_LOST");
        }
        if self.deadline.load(Ordering::Acquire) || epoch_ms() >= self.deadline_at {
            self.deadline.store(true, Ordering::Release);
            bail!("RUST_COMPUTE_DEADLINE_EXCEEDED");
        }
        if self.cancelled.load(Ordering::Acquire) {
            bail!("RUST_COMPUTE_CANCELLED");
        }
        Ok(())
    }
}

fn start_heartbeat(
    settings: Settings,
    claim: JobClaim,
    state: Arc<LeaseState>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut repository = match WorkerRepository::connect(&settings.database_url) {
            Ok(repository) => repository,
            Err(_) => {
                state.lost.store(true, Ordering::Release);
                return;
            }
        };
        while !state.stop.load(Ordering::Acquire) {
            let current = epoch_ms();
            if current >= claim.deadline_at {
                state.deadline.store(true, Ordering::Release);
                return;
            }
            let wait = settings
                .heartbeat_ms
                .min((claim.deadline_at - current).max(1) as u64);
            thread::park_timeout(Duration::from_millis(wait));
            if state.stop.load(Ordering::Acquire) {
                return;
            }
            match repository.heartbeat(&claim, settings.lease_ms) {
                Ok((true, true)) => {
                    state.cancelled.store(true, Ordering::Release);
                    return;
                }
                Ok((true, false)) => {}
                _ => {
                    state.lost.store(true, Ordering::Release);
                    return;
                }
            }
        }
    })
}

fn append_metrics(output: &mut WorkerOutput, started: Instant, claim: &JobClaim) {
    let serialization_started = Instant::now();
    let serialized_result_bytes = serde_json::to_vec(&output).ok().map(|value| value.len());
    let serialization_ms = serialization_started.elapsed().as_secs_f64() * 1000.0;
    let artifact = OutputArtifact {
        artifact_type: "worker-metrics".into(),
        content: json!({
            "compute_ms": started.elapsed().as_secs_f64() * 1000.0,
            "serialization_ms": serialization_ms,
            "serialized_result_bytes": serialized_result_bytes,
            "peak_process_rss_bytes": peak_process_rss_bytes(),
            "attempt": claim.attempt_count,
            "engine": portfolio_lens_compute::ENGINE_VERSION,
            "ipc": "postgres_artifact_queue",
            "cancellation": "lease_cooperative_checkpoints",
        }),
        row_count: Some(1),
    };
    output.artifacts.get_or_insert_with(Vec::new).push(artifact);
}

fn stop_heartbeat(state: &LeaseState, heartbeat: thread::JoinHandle<()>) {
    state.stop.store(true, Ordering::Release);
    heartbeat.thread().unpark();
    let _ = heartbeat.join();
}

fn process_one(repository: &mut WorkerRepository, settings: &Settings) -> Result<bool> {
    let Some(claim) = repository.claim(&settings.worker_id, settings.lease_ms)? else {
        return Ok(false);
    };
    require_valid_worker_engine(&claim)?;
    let state = Arc::new(LeaseState {
        stop: AtomicBool::new(false),
        lost: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        deadline: AtomicBool::new(false),
        deadline_at: claim.deadline_at,
    });
    let heartbeat = start_heartbeat(settings.clone(), claim.clone(), state.clone());
    let started = Instant::now();
    let outcome = (|| -> Result<(WorkerInput, WorkerOutput)> {
        let input = repository.load_input(&claim)?;
        let mut output = compute::compute_with_control(&input, true, Some(state.as_ref()))?;
        append_metrics(&mut output, started, &claim);
        output.validate_for(&input)?;
        Ok((input, output))
    })();
    let finalization = (|| -> Result<()> {
        if state.lost.load(Ordering::Acquire) {
            return Ok(());
        }
        if state.deadline.load(Ordering::Acquire) {
            let error = worker_error(
                "RUN_DEADLINE_EXCEEDED",
                "Rust worker absolute deadline exceeded",
                true,
            );
            let _ = repository.fail(&claim, &error, false, 0)?;
            return Ok(());
        }
        if state.cancelled.load(Ordering::Acquire) {
            let error = worker_error("RUN_CANCELLED", "run cancellation was requested", false);
            let _ = repository.fail(&claim, &error, false, 0)?;
            return Ok(());
        }
        match outcome {
            Ok((input, output)) => {
                let _ = repository.complete(&claim, &input, &output)?;
            }
            Err(error) => {
                let message = error.to_string();
                let invalid = message.contains("invalid")
                    || message.contains("required")
                    || message.contains("must be")
                    || message.contains("unsupported");
                let code = if invalid {
                    "INVALID_WORKER_INPUT"
                } else {
                    "WORKER_COMPUTE_FAILED"
                };
                let detail = worker_error(code, &message, !invalid);
                let _ = repository.fail(&claim, &detail, !invalid, 1_000)?;
            }
        }
        Ok(())
    })();
    stop_heartbeat(&state, heartbeat);
    finalization?;
    Ok(true)
}

fn durable(once: bool) -> Result<()> {
    let settings = Settings::from_env()?;
    let mut repository = WorkerRepository::connect(&settings.database_url)?;
    let mut next_recovery = Instant::now();
    loop {
        if Instant::now() >= next_recovery {
            let _ = repository.recover_expired(100)?;
            next_recovery = Instant::now() + Duration::from_millis(settings.recovery_ms);
        }
        let processed = process_one(&mut repository, &settings)?;
        if once {
            return Ok(());
        }
        if !processed {
            thread::sleep(Duration::from_millis(settings.poll_ms));
        }
    }
}

fn usage() {
    eprintln!(
        "portfolio-lens-worker commands:\n  compute-json <job-kind>\n  serve --socket <path> [--max-active <count>] [--max-connections <count>]\n  health --socket <path>\n  run\n  once"
    );
}

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("compute-json") if args.len() == 2 => direct(job_kind(
            args.get(1).context("compute-json requires a job kind")?,
        )?),
        Some("serve") => serve(&serve_options(&args)?),
        Some("health") => socket_health(socket_path_arg(&args, "health")?),
        Some("run") => durable(false),
        Some("once") => durable(true),
        _ => {
            usage();
            bail!("a supported command is required")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_socket_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "portfolio-lens-worker-{label}-{}-{}.sock",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn socket_path_argument_requires_a_value_and_accepts_a_path() {
        let missing_flag = vec!["health".to_string()];
        assert!(
            socket_path_arg(&missing_flag, "health")
                .unwrap_err()
                .to_string()
                .contains("health requires --socket <path>")
        );

        let missing_value = vec!["health".to_string(), "--socket".to_string()];
        assert!(
            socket_path_arg(&missing_value, "health")
                .unwrap_err()
                .to_string()
                .contains("health requires --socket <path>")
        );

        let option_instead_of_value = vec![
            "health".to_string(),
            "--socket".to_string(),
            "--other".to_string(),
        ];
        assert!(
            socket_path_arg(&option_instead_of_value, "health")
                .unwrap_err()
                .to_string()
                .contains("health requires --socket <path>")
        );

        let valid = vec![
            "health".to_string(),
            "--socket".to_string(),
            "/app/run/compute.sock".to_string(),
        ];
        assert_eq!(
            socket_path_arg(&valid, "health").unwrap(),
            "/app/run/compute.sock"
        );
    }

    #[test]
    fn serve_options_apply_bounded_defaults_and_validate_capacity() {
        let defaults = vec![
            "serve".to_string(),
            "--socket".to_string(),
            "/app/run/compute.sock".to_string(),
        ];
        assert_eq!(
            serve_options(&defaults).unwrap(),
            ServeOptions {
                socket_path: "/app/run/compute.sock".to_string(),
                max_active: DEFAULT_SOCKET_MAX_ACTIVE,
                max_connections: DEFAULT_SOCKET_MAX_CONNECTIONS,
            }
        );

        let explicit = vec![
            "serve".to_string(),
            "--socket".to_string(),
            "/tmp/compute.sock".to_string(),
            "--max-active".to_string(),
            "6".to_string(),
            "--max-connections".to_string(),
            "12".to_string(),
        ];
        assert_eq!(
            serve_options(&explicit).unwrap(),
            ServeOptions {
                socket_path: "/tmp/compute.sock".to_string(),
                max_active: 6,
                max_connections: 12,
            }
        );

        for invalid in [
            vec![
                "serve".to_string(),
                "--socket".to_string(),
                "/tmp/compute.sock".to_string(),
                "--max-active".to_string(),
                "0".to_string(),
            ],
            vec![
                "serve".to_string(),
                "--socket".to_string(),
                "/tmp/compute.sock".to_string(),
                "--max-active".to_string(),
                "4".to_string(),
                "--max-connections".to_string(),
                "2".to_string(),
            ],
        ] {
            assert!(serve_options(&invalid).is_err());
        }
    }

    #[test]
    fn admission_bounds_waiters_and_releases_raii_permits() {
        let admission = Arc::new(Admission::new(1));
        let first = admission.try_acquire().expect("first permit");
        assert_eq!(admission.active(), 1);
        assert!(admission.try_acquire().is_none());

        let waiting_admission = admission.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let waiter = thread::spawn(move || {
            let _permit = waiting_admission.acquire();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(25)).is_err());
        drop(first);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        waiter.join().unwrap();
        assert_eq!(admission.active(), 0);
    }

    #[test]
    fn socket_health_rejects_missing_and_regular_file_targets() {
        let missing = test_socket_path("missing-health");
        let missing_error =
            socket_health_with_timeout(missing.to_str().unwrap(), Duration::from_secs(1))
                .unwrap_err();
        assert!(missing_error.to_string().contains("inspect Unix socket"));

        let regular = test_socket_path("regular-health");
        fs::write(&regular, b"not a socket").unwrap();
        let regular_error =
            socket_health_with_timeout(regular.to_str().unwrap(), Duration::from_secs(1))
                .unwrap_err();
        assert!(
            regular_error
                .to_string()
                .contains("health target is not a Unix socket")
        );
        fs::remove_file(regular).unwrap();
    }

    #[test]
    fn socket_health_connects_to_a_live_socket() {
        let socket_path = test_socket_path("live-health");
        let listener = match UnixListener::bind(&socket_path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind health test Unix socket: {error}"),
        };
        let accept_thread = thread::spawn(move || listener.accept().map(|_| ()));

        socket_health_with_timeout(socket_path.to_str().unwrap(), Duration::from_secs(1)).unwrap();
        accept_thread.join().unwrap().unwrap();
        fs::remove_file(socket_path).unwrap();
    }

    #[test]
    fn socket_control_detects_disconnect_without_consuming_pipelined_data() {
        let (mut server, mut peer) = UnixStream::pair().unwrap();
        let control = SocketControl::with_interval(server.as_raw_fd(), 1);

        control.checkpoint().unwrap();
        if let Err(error) = peer.write_all(&[7]) {
            if error.kind() == ErrorKind::PermissionDenied {
                return;
            }
            panic!("write UnixStream pair: {error}");
        }
        control.checkpoint().unwrap();
        let mut received = [0_u8; 1];
        server.read_exact(&mut received).unwrap();
        assert_eq!(received, [7]);

        drop(peer);
        assert!(
            control
                .checkpoint()
                .unwrap_err()
                .to_string()
                .contains("CLIENT_DISCONNECTED")
        );
    }

    #[test]
    fn lease_control_sets_typed_deadline_and_cancellation_reasons() {
        let expired = LeaseState {
            stop: AtomicBool::new(false),
            lost: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            deadline: AtomicBool::new(false),
            deadline_at: epoch_ms() - 1,
        };
        assert!(
            expired
                .checkpoint()
                .unwrap_err()
                .to_string()
                .contains("DEADLINE_EXCEEDED")
        );
        assert!(expired.deadline.load(Ordering::Acquire));

        let cancelled = LeaseState {
            stop: AtomicBool::new(false),
            lost: AtomicBool::new(false),
            cancelled: AtomicBool::new(true),
            deadline: AtomicBool::new(false),
            deadline_at: epoch_ms() + 10_000,
        };
        assert!(
            cancelled
                .checkpoint()
                .unwrap_err()
                .to_string()
                .contains("CANCELLED")
        );
    }

    #[test]
    fn technical_analysis_round_trips_over_the_real_length_framed_socket() {
        let (server, mut client) = UnixStream::pair().unwrap();
        let server_thread = thread::spawn(move || handle_socket(server));
        let request = json!({
            "schema_version": portfolio_lens_compute::WORKER_SCHEMA_VERSION,
            "engine_version": portfolio_lens_compute::ENGINE_VERSION,
            "run_id": "technical-socket-test",
            "job_kind": "technical_analysis",
            "data_revision": "technical-revision-1",
            "request_hash": "b".repeat(64),
            "payload": {
                "technical_analysis": {
                    "schema_version": portfolio_lens_compute::indicators::TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
                    "response_mode": "latest_summary",
                    "adjustment_policy": "adjusted",
                    "instruments": [{
                        "key": "USD:AAPL",
                        "symbol": "AAPL",
                        "market": "US",
                        "currency": "USD",
                        "instrument_type": "stock",
                        "bars": [{
                            "date": "2024-01-02",
                            "open": 185.0,
                            "high": 188.0,
                            "low": 184.0,
                            "close": 187.0,
                            "volume": 1000000.0
                        }]
                    }],
                    "indicators": [{"id": "ema-20", "kind": "ema"}]
                }
            },
            "include_artifacts": true
        });
        if let Err(error) = write_socket_frame(&mut client, &request) {
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::PermissionDenied)
            {
                drop(client);
                let _ = server_thread.join();
                return;
            }
            panic!("write technical analysis socket frame: {error}");
        }
        let source = read_socket_frame(&mut client).unwrap().unwrap();
        let output: WorkerOutput = serde_json::from_slice(&source).unwrap();
        assert_eq!(output.job_kind, JobKind::TechnicalAnalysis);
        assert_eq!(output.status, "completed");
        assert_eq!(
            output.result.as_ref().unwrap()["indicator_engine_version"],
            portfolio_lens_compute::indicators::INDICATOR_ENGINE_VERSION
        );
        assert!(
            output
                .artifacts
                .as_ref()
                .unwrap()
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-indicators")
        );
        drop(client);
        server_thread.join().unwrap().unwrap();
    }

    #[test]
    fn scalping_analysis_batch_round_trips_over_the_real_length_framed_socket() {
        let (server, mut client) = UnixStream::pair().unwrap();
        let server_thread = thread::spawn(move || handle_socket(server));
        let mut request = json!({
            "schema_version": portfolio_lens_compute::WORKER_SCHEMA_VERSION,
            "engine_version": portfolio_lens_compute::ENGINE_VERSION,
            "run_id": "scalping-socket-test",
            "job_kind": "scalping_analysis",
            "data_revision": "intraday-revision-1",
            "request_hash": "d".repeat(64),
            "payload": {
                "scalping_analysis": {
                    "schema_version": portfolio_lens_compute::scalping::SCALPING_REQUEST_SCHEMA_VERSION,
                    "response_mode": "latest_summary",
                    "adjustment_policy": "adjusted",
                    "interval_minutes": 1,
                    "instruments": [{
                        "key": "KRW:005930",
                        "symbol": "005930",
                        "market": "KRX",
                        "currency": "KRW",
                        "instrument_type": "stock",
                        "session_start_confirmed_dates": ["2026-07-21"],
                        "complete_session_dates": [],
                        "session_windows": [
                            { "kind": "pre_market", "open_minute": 480, "close_minute": 530 },
                            { "kind": "regular_market", "open_minute": 540, "close_minute": 930 },
                            { "kind": "after_market", "open_minute": 940, "close_minute": 1200 }
                        ],
                        "bars": [
                            {
                                "timestamp": "2026-07-21T09:01:00+09:00",
                                "session_date": "2026-07-21",
                                "open": 100.0,
                                "high": 101.0,
                                "low": 99.0,
                                "close": 100.5,
                                "volume": 1000.0,
                                "amount": 100500.0,
                                "complete": true
                            },
                            {
                                "timestamp": "2026-07-21T09:02:00+09:00",
                                "session_date": "2026-07-21",
                                "open": 100.5,
                                "high": 102.0,
                                "low": 100.0,
                                "close": 101.5,
                                "volume": 1200.0,
                                "amount": 121800.0,
                                "complete": true
                            }
                        ]
                    }],
                    "indicators": [{
                        "id": "sma-one",
                        "kind": "sma",
                        "parameters": {"period": 1}
                    }],
                    "relative_volume_lookback_sessions": 5,
                    "signal": {
                        "enabled": false,
                        "preset": "trend"
                    }
                }
            },
            "include_artifacts": true
        });
        let mut second = request
            .pointer("/payload/scalping_analysis/instruments/0")
            .cloned()
            .unwrap();
        second["key"] = json!("USDT:BTCUSDT");
        second["symbol"] = json!("BTCUSDT");
        second["market"] = json!("CRYPTO");
        second["currency"] = json!("USDT");
        second["instrument_type"] = json!("crypto");
        request
            .pointer_mut("/payload/scalping_analysis/instruments")
            .and_then(Value::as_array_mut)
            .unwrap()
            .push(second);
        if let Err(error) = write_socket_frame(&mut client, &request) {
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::PermissionDenied)
            {
                drop(client);
                let _ = server_thread.join();
                return;
            }
            panic!("write scalping analysis socket frame: {error}");
        }
        let source = read_socket_frame(&mut client).unwrap().unwrap();
        let output: WorkerOutput = serde_json::from_slice(&source).unwrap();
        assert_eq!(output.job_kind, JobKind::ScalpingAnalysis);
        assert_eq!(output.status, "completed");
        assert_eq!(
            output.result.as_ref().unwrap()["schema_version"],
            portfolio_lens_compute::scalping::SCALPING_RESULT_SCHEMA_VERSION
        );
        assert_eq!(
            output.result.as_ref().unwrap()["instruments"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            output.result.as_ref().unwrap()["instruments"][0]["indicators"][0]["latest"]["timestamp"],
            "2026-07-21T09:02:00+09:00"
        );
        assert!(
            output
                .artifacts
                .as_ref()
                .unwrap()
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-signals")
        );
        drop(client);
        server_thread.join().unwrap().unwrap();
    }

    #[test]
    fn technical_strategy_round_trips_over_the_real_length_framed_socket() {
        let (server, mut client) = UnixStream::pair().unwrap();
        let server_thread = thread::spawn(move || handle_socket(server));
        let request = json!({
            "schema_version": portfolio_lens_compute::WORKER_SCHEMA_VERSION,
            "engine_version": portfolio_lens_compute::ENGINE_VERSION,
            "run_id": "technical-strategy-socket-test",
            "job_kind": "technical_strategy",
            "data_revision": "technical-strategy-revision-1",
            "request_hash": "d".repeat(64),
            "payload": {
                "technical_analysis": {
                    "schema_version": portfolio_lens_compute::indicators::TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
                    "response_mode": "full_series",
                    "adjustment_policy": "adjusted",
                    "instruments": [{
                        "key": "KRW:AAA",
                        "symbol": "AAA",
                        "market": "KR",
                        "currency": "KRW",
                        "instrument_type": "stock",
                        "bars": [
                            {"date": "2024-01-01", "open": 9.0, "high": 10.0, "low": 8.0, "close": 9.0, "volume": 1000.0},
                            {"date": "2024-01-02", "open": 11.0, "high": 12.0, "low": 10.0, "close": 11.0, "volume": 1000.0},
                            {"date": "2024-01-03", "open": 12.0, "high": 13.0, "low": 11.0, "close": 12.0, "volume": 1000.0}
                        ]
                    }],
                    "indicators": [{"id": "sma-one", "kind": "sma", "parameters": {"period": 1}}]
                },
                "strategy": {
                    "schema_version": portfolio_lens_compute::technical_strategy::TECHNICAL_STRATEGY_SCHEMA_VERSION,
                    "initial_state": "inactive",
                    "active_when": {
                        "operator": "crosses_above",
                        "left": {"type": "bar", "instrument_key": "KRW:AAA", "field": "close"},
                        "right": {"type": "constant", "value": 10.0}
                    },
                    "inactive_when": {
                        "operator": "greater_than",
                        "left": {"type": "constant", "value": 0.0},
                        "right": {"type": "constant", "value": 1.0}
                    },
                    "minimum_holding_period": 0,
                    "cooldown_period": 0,
                    "allocations": {
                        "active": {"weights": {"AAA": 100.0}, "cash_target_percent": 0.0},
                        "inactive": {"weights": {"AAA": 0.0}, "cash_target_percent": 100.0}
                    }
                },
                "safe_trade_dates": ["2024-01-01", "2024-01-02", "2024-01-03"],
                "evaluation_start_date": "2024-01-01",
                "evaluation_end_date": "2024-01-03"
            },
            "include_artifacts": true
        });
        if let Err(error) = write_socket_frame(&mut client, &request) {
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::PermissionDenied)
            {
                drop(client);
                let _ = server_thread.join();
                return;
            }
            panic!("write technical strategy socket frame: {error}");
        }
        let source = read_socket_frame(&mut client).unwrap().unwrap();
        let output: WorkerOutput = serde_json::from_slice(&source).unwrap();
        assert_eq!(output.job_kind, JobKind::TechnicalStrategy);
        assert_eq!(output.status, "completed");
        assert_eq!(
            output.result.as_ref().unwrap()["technical_strategy"]["signals"][0]["status"],
            "planned"
        );
        assert!(output.result.as_ref().unwrap().get("backtest").is_none());
        let artifacts = output.artifacts.as_ref().unwrap();
        assert!(
            artifacts
                .iter()
                .any(|artifact| artifact.artifact_type == "technical-signals")
        );
        drop(client);
        server_thread.join().unwrap().unwrap();
    }
}
