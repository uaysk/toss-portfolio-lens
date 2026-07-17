from __future__ import annotations

import argparse
import json
import resource
import signal
import sys
import threading
import time
from typing import Any

from .backtest_engine import simulate_backtest
from .compute import compute_worker_input
from .contracts import OutputArtifact
from .optimization import optimize_portfolio
from .repository import JobClaim, WorkerRepository, epoch_ms
from .settings import WorkerSettings


class LeaseLostError(RuntimeError):
    pass


class CancellationObservedError(RuntimeError):
    pass


class DeadlineExceededError(RuntimeError):
    pass


class LeaseMonitor:
    def __init__(self, repository: WorkerRepository, claim: JobClaim, settings: WorkerSettings) -> None:
        self.repository = repository
        self.claim = claim
        self.settings = settings
        self.stop_event = threading.Event()
        self.lost_event = threading.Event()
        self.cancel_event = threading.Event()
        self.deadline_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"heartbeat-{claim.run_id}", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=max(1.0, self.settings.heartbeat_ms / 1_000 * 2))

    def checkpoint(self) -> None:
        if self.deadline_event.is_set() or epoch_ms() >= self.claim.deadline_at:
            self.deadline_event.set()
            raise DeadlineExceededError("run absolute deadline was exceeded")
        if self.lost_event.is_set():
            raise LeaseLostError("worker lease was lost")
        if self.cancel_event.is_set():
            raise CancellationObservedError("run cancellation was requested")

    def progress(self, value: float, completed: int, total: int) -> None:
        self.checkpoint()
        if not self.repository.update_progress(
            self.claim,
            value,
            completed_candidates=completed,
            total_candidates=total,
        ):
            self.lost_event.set()
            raise LeaseLostError("worker progress fencing failed")

    def _run(self) -> None:
        interval = self.settings.heartbeat_ms / 1_000
        while not self.stop_event.is_set():
            remaining = (self.claim.deadline_at - epoch_ms()) / 1_000
            if remaining <= 0:
                self.deadline_event.set()
                try:
                    self.repository.expire_deadline(self.claim)
                except Exception:
                    self.lost_event.set()
                return
            if self.stop_event.wait(min(interval, remaining)):
                return
            if epoch_ms() >= self.claim.deadline_at:
                continue
            try:
                renewed, cancelled = self.repository.heartbeat(self.claim, self.settings.lease_ms)
            except Exception:
                self.lost_event.set()
                return
            if not renewed:
                self.lost_event.set()
                return
            if cancelled:
                self.cancel_event.set()
                return


def _read_json() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def _write_json(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    sys.stdout.write("\n")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="portfolio-compute-worker")
    subcommands = parser.add_subparsers(dest="command", required=True)
    optimize = subcommands.add_parser("optimize-json", help="compute one raw optimization input from stdin")
    optimize.add_argument("--batch-size", type=int, default=512)
    subcommands.add_parser("backtest-json", help="compute one serialized backtest simulation input from stdin")
    subcommands.add_parser("run", help="poll PostgreSQL and process jobs until terminated")
    subcommands.add_parser("once", help="claim and process at most one PostgreSQL job")
    return parser


def _process_one(repository: WorkerRepository, settings: WorkerSettings) -> bool:
    claim = repository.claim(settings.worker_id, settings.lease_ms)
    if claim is None:
        return False
    monitor = LeaseMonitor(repository, claim, settings)
    monitor.start()
    try:
        compute_started = time.perf_counter()
        worker_input = repository.load_input(claim)
        output = compute_worker_input(
            worker_input,
            candidate_batch_size=settings.candidate_batch_size,
            checkpoint=monitor.checkpoint,
            progress=monitor.progress,
        )
        compute_ms = (time.perf_counter() - compute_started) * 1_000
        output.artifacts = [
            *(output.artifacts or []),
            OutputArtifact(
                type="worker-metrics",
                content={
                    "compute_ms": compute_ms,
                    "max_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1_024,
                    "attempt": claim.attempt_count,
                },
                row_count=1,
            ),
        ]
        monitor.checkpoint()
        repository.complete(claim, output)
    except DeadlineExceededError:
        repository.expire_deadline(claim)
    except CancellationObservedError:
        repository.fail(
            claim,
            {"code": "RUN_CANCELLED", "message": "run cancellation was requested", "retryable": False},
            retryable=False,
        )
    except LeaseLostError:
        pass
    except (ValueError, TypeError, KeyError) as error:
        repository.fail(
            claim,
            {"code": "INVALID_WORKER_INPUT", "message": str(error)[:500], "retryable": False},
            retryable=False,
        )
    except Exception as error:
        repository.fail(
            claim,
            {"code": "WORKER_COMPUTE_FAILED", "message": str(error)[:500], "retryable": True},
            retryable=True,
            retry_delay_ms=1_000,
        )
    finally:
        monitor.stop()
    return True


def _run_worker(*, once: bool) -> None:
    settings = WorkerSettings.from_env()
    repository = WorkerRepository(settings.conninfo)
    repository.open()
    stopping = threading.Event()

    def stop(_signal: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_recovery = 0.0
    try:
        while not stopping.is_set():
            current = time.monotonic()
            if current >= next_recovery:
                repository.recover_expired()
                next_recovery = current + settings.recovery_ms / 1_000
            processed = _process_one(repository, settings)
            if once:
                return
            if not processed:
                stopping.wait(settings.poll_ms / 1_000)
    finally:
        repository.close()


def main() -> None:
    args = _parser().parse_args()
    if args.command == "optimize-json":
        _write_json(optimize_portfolio(_read_json(), batch_size=args.batch_size))
        return
    if args.command == "backtest-json":
        _write_json(simulate_backtest(_read_json()))
        return
    if args.command == "run":
        _run_worker(once=False)
        return
    if args.command == "once":
        _run_worker(once=True)
        return
    raise RuntimeError(f"unsupported command: {args.command}")


if __name__ == "__main__":
    main()
