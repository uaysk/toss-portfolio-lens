use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use portfolio_lens_compute::compute;
use portfolio_lens_compute::contracts::{
    JobKind, OutputArtifact, WorkerInput, WorkerOutput, job_kind, parse_raw_job,
};
use portfolio_lens_compute::control::ComputeControl;
use portfolio_lens_compute::repository::{
    JobClaim, WorkerRepository, epoch_ms, require_database_url, require_valid_worker_engine,
    worker_error,
};
use serde_json::{Value, json};

const MAX_SOCKET_FRAME_BYTES: usize = 128 * 1024 * 1024;
const SOCKET_PEER_CHECK_INTERVAL: usize = 32;

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

fn direct(kind: JobKind, legacy_result_only: bool) -> Result<()> {
    let value = read_stdin_json()?;
    let input = if value.get("schema_version").is_some() {
        let input: WorkerInput = serde_json::from_value(value)?;
        input.validate()?;
        input
    } else {
        let payload = match kind {
            JobKind::Backtest if value.get("simulation").is_none() => json!({"simulation": value}),
            JobKind::Optimization if value.get("optimization").is_none() => {
                json!({"optimization": value})
            }
            JobKind::MonteCarlo if value.get("monte_carlo").is_none() => {
                json!({"monte_carlo": value})
            }
            _ => value,
        };
        parse_raw_job(kind, payload)?
    };
    let output = compute::compute(&input)?;
    if legacy_result_only {
        write_json(output.result.as_ref().unwrap_or(&Value::Null))
    } else {
        write_json(&output)
    }
}

fn raw_optimization() -> Result<()> {
    let value = read_stdin_json()?;
    write_json(&portfolio_lens_compute::optimization::optimize(&value)?)
}

fn parse_socket_input(value: Value) -> Result<WorkerInput> {
    if value.get("schema_version").is_some() {
        let input: WorkerInput = serde_json::from_value(value)?;
        input.validate()?;
        return Ok(input);
    }
    let kind = value
        .get("job_kind")
        .and_then(Value::as_str)
        .context("socket request job_kind is required")?;
    let payload = value
        .get("payload")
        .cloned()
        .context("socket request payload is required")?;
    parse_raw_job(job_kind(kind)?, payload)
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

fn write_socket_frame(stream: &mut UnixStream, value: &impl serde::Serialize) -> Result<()> {
    let source = serde_json::to_vec(value)?;
    if source.len() > MAX_SOCKET_FRAME_BYTES {
        bail!("socket response exceeds 128 MiB");
    }
    if source.len() > u32::MAX as usize {
        bail!("socket response exceeds frame length field");
    }
    stream.write_all(&(source.len() as u32).to_be_bytes())?;
    stream.write_all(&source)?;
    stream.flush()?;
    Ok(())
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

fn handle_socket(mut stream: UnixStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.set_write_timeout(Some(Duration::from_secs(300)))?;
    while let Some(source) = read_socket_frame(&mut stream)? {
        let started = Instant::now();
        let response = (|| -> Result<WorkerOutput> {
            let value: Value =
                serde_json::from_slice(&source).context("invalid framed JSON request")?;
            let include_artifacts = value
                .get("include_artifacts")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let input = parse_socket_input(value)?;
            let compute_started = Instant::now();
            let control = SocketControl::new(stream.as_raw_fd());
            let mut output =
                compute::compute_with_control(&input, include_artifacts, Some(&control))?;
            let compute_ms = compute_started.elapsed().as_secs_f64() * 1000.0;
            let serialization_started = Instant::now();
            let serialized_result_bytes = serde_json::to_vec(&output)?.len();
            let serialization_ms = serialization_started.elapsed().as_secs_f64() * 1000.0;
            output
                .artifacts
                .get_or_insert_with(Vec::new)
                .push(OutputArtifact {
                    artifact_type: "worker-metrics".into(),
                    content: json!({
                        "request_decode_ms": compute_started.duration_since(started).as_secs_f64() * 1000.0,
                        "compute_ms": compute_ms,
                        "serialization_ms": serialization_ms,
                        "serialized_result_bytes": serialized_result_bytes,
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
            Ok(output) => write_socket_frame(&mut stream, &output)?,
            Err(error) => write_socket_frame(
                &mut stream,
                &json!({
                    "status": "failed",
                    "error": {"code":"RUST_COMPUTE_FAILED", "message": error.to_string(), "retryable": false},
                }),
            )?,
        }
    }
    Ok(())
}

fn serve(socket_path: &str) -> Result<()> {
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
    eprintln!("portfolio-lens Rust compute listening on {socket_path}");
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                thread::spawn(move || {
                    if let Err(error) = handle_socket(stream) {
                        eprintln!("socket request failed: {error:#}");
                    }
                });
            }
            Err(error) => eprintln!("socket accept failed: {error}"),
        }
    }
    Ok(())
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
        "portfolio-lens-worker commands:\n  backtest-json\n  optimize-json\n  monte-carlo-json\n  compute-json <job-kind>\n  serve --socket <path>\n  run\n  once"
    );
}

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("backtest-json") => direct(JobKind::Backtest, true),
        Some("optimize-json") => raw_optimization(),
        Some("monte-carlo-json") => direct(JobKind::MonteCarlo, true),
        Some("compute-json") => direct(
            job_kind(args.get(1).context("compute-json requires a job kind")?)?,
            false,
        ),
        Some("serve") => {
            let index = args
                .iter()
                .position(|value| value == "--socket")
                .context("serve requires --socket <path>")?;
            serve(
                args.get(index + 1)
                    .context("serve requires --socket <path>")?,
            )
        }
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
}
