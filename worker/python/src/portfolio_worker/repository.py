from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .contracts import (
    ARTIFACT_ENCODING,
    ARTIFACT_FORMAT,
    SCHEMA_VERSION,
    WorkerInput,
    WorkerOutput,
    SUPPORTED_ENGINE_VERSION,
    decode_artifact,
    encode_artifact,
)


def epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


@dataclass(frozen=True, slots=True)
class JobClaim:
    run_id: str
    job_kind: str
    lease_owner: str
    lease_expires_at: int
    deadline_at: int
    attempt_count: int
    max_attempts: int
    input_artifact_id: str
    data_revision: str
    engine_version: str
    request_hash: str


class WorkerRepository:
    def __init__(self, conninfo: str) -> None:
        self.pool = ConnectionPool(
            conninfo=conninfo,
            min_size=1,
            max_size=4,
            open=False,
            kwargs={"row_factory": dict_row, "autocommit": False},
        )

    def open(self) -> None:
        self.pool.open(wait=True, timeout=10)
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                SELECT to_regclass('public.portfolio_run_jobs') AS jobs,
                       to_regclass('public.portfolio_worker_artifacts') AS artifacts
                """
            ).fetchone()
            if not row or not row["jobs"] or not row["artifacts"]:
                raise RuntimeError("worker queue schema is not initialized")

    def close(self) -> None:
        self.pool.close()

    def claim(self, worker_id: str, lease_ms: int, *, now: int | None = None) -> JobClaim | None:
        current = epoch_ms() if now is None else now
        owner = f"{worker_id[:96]}:{uuid4()}"
        expires_at = current + lease_ms
        with self.pool.connection() as connection, connection.transaction():
            selected = connection.execute(
                """
                SELECT job.run_id, job.job_kind, job.attempt_count, job.max_attempts,
                       job.input_artifact_id, job.deadline_at, run.data_revision, run.engine_version,
                       run.request_hash
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.state = 'queued' AND job.available_at <= %s
                  AND job.deadline_at > %s AND job.attempt_count < job.max_attempts
                  AND run.status = 'queued' AND job.job_kind = run.run_kind
                  AND run.engine_version = %s
                ORDER BY job.priority ASC, job.available_at ASC, job.created_at ASC
                FOR UPDATE OF job, run SKIP LOCKED
                LIMIT 1
                """,
                (current, current, SUPPORTED_ENGINE_VERSION),
            ).fetchone()
            if not selected:
                return None
            job_update = connection.execute(
                """
                UPDATE portfolio_run_jobs
                SET state = 'running', lease_owner = %s, lease_expires_at = %s,
                    heartbeat_at = %s, attempt_count = attempt_count + 1, updated_at = %s
                WHERE run_id = %s AND state = 'queued'
                """,
                (owner, expires_at, current, current, selected["run_id"]),
            )
            run_update = connection.execute(
                """
                UPDATE portfolio_backtest_runs
                SET status = 'running', started_at = COALESCE(started_at, %s), updated_at = %s
                WHERE run_id = %s AND status = 'queued'
                """,
                (current, current, selected["run_id"]),
            )
            if job_update.rowcount != 1 or run_update.rowcount != 1:
                raise RuntimeError("job claim state transition conflict")
            self._event(
                connection,
                selected["run_id"],
                "worker_claimed",
                {"worker_id": worker_id[:96], "lease_expires_at": expires_at},
                current,
            )
            return JobClaim(
                run_id=selected["run_id"],
                job_kind=selected["job_kind"],
                lease_owner=owner,
                lease_expires_at=expires_at,
                deadline_at=int(selected["deadline_at"]),
                attempt_count=int(selected["attempt_count"]) + 1,
                max_attempts=int(selected["max_attempts"]),
                input_artifact_id=selected["input_artifact_id"],
                data_revision=selected["data_revision"],
                engine_version=selected["engine_version"],
                request_hash=selected["request_hash"],
            )

    def load_input(self, claim: JobClaim) -> WorkerInput:
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                SELECT artifact.content, artifact.checksum, artifact.schema_version,
                       artifact.data_revision, artifact.artifact_role, artifact.format,
                       artifact.content_encoding
                FROM portfolio_worker_artifacts artifact
                JOIN portfolio_run_jobs job ON job.input_artifact_id = artifact.artifact_id
                WHERE job.run_id = %s AND artifact.artifact_id = %s
                """,
                (claim.run_id, claim.input_artifact_id),
            ).fetchone()
        if not row:
            raise RuntimeError("worker input artifact not found")
        if (
            row["artifact_role"] != "input"
            or row["format"] != ARTIFACT_FORMAT
            or row["content_encoding"] != ARTIFACT_ENCODING
            or row["schema_version"] != SCHEMA_VERSION
            or row["data_revision"] != claim.data_revision
        ):
            raise RuntimeError("worker input artifact metadata mismatch")
        value = decode_artifact(bytes(row["content"]), row["checksum"], expect_input=True)
        if not isinstance(value, WorkerInput):
            raise RuntimeError("worker input artifact type mismatch")
        if (
            value.run_id != claim.run_id
            or value.job_kind.value != claim.job_kind
            or value.data_revision != claim.data_revision
            or value.engine_version != claim.engine_version
            or value.request_hash != claim.request_hash
        ):
            raise RuntimeError("worker input contract does not match claimed job")
        return value

    def heartbeat(
        self,
        claim: JobClaim,
        lease_ms: int,
        *,
        now: int | None = None,
    ) -> tuple[bool, bool]:
        current = epoch_ms() if now is None else now
        with self.pool.connection() as connection, connection.transaction():
            updated = connection.execute(
                """
                UPDATE portfolio_run_jobs
                SET heartbeat_at = %s, lease_expires_at = %s, updated_at = %s
                WHERE run_id = %s AND state = 'running' AND lease_owner = %s
                  AND lease_expires_at > %s AND deadline_at > %s
                """,
                (current, current + lease_ms, current, claim.run_id, claim.lease_owner, current, current),
            )
            if updated.rowcount != 1:
                return False, False
            row = connection.execute(
                "SELECT status FROM portfolio_backtest_runs WHERE run_id = %s",
                (claim.run_id,),
            ).fetchone()
            return True, bool(row and row["status"] == "cancel_requested")

    def update_progress(
        self,
        claim: JobClaim,
        progress: float,
        *,
        completed_candidates: int | None = None,
        total_candidates: int | None = None,
        validation_window: str | None = None,
        now: int | None = None,
    ) -> bool:
        current = epoch_ms() if now is None else now
        with self.pool.connection() as connection, connection.transaction():
            updated = connection.execute(
                """
                UPDATE portfolio_backtest_runs run
                SET progress = %s, completed_candidates = COALESCE(%s, completed_candidates),
                    total_candidates = COALESCE(%s, total_candidates),
                    current_validation_window = %s, updated_at = %s
                WHERE run.run_id = %s AND run.status IN ('running', 'cancel_requested')
                  AND EXISTS (
                    SELECT 1 FROM portfolio_run_jobs job
                    WHERE job.run_id = run.run_id AND job.state = 'running'
                      AND job.lease_owner = %s AND job.lease_expires_at > %s
                      AND job.deadline_at > %s
                  )
                """,
                (
                    max(0.0, min(1.0, progress)),
                    completed_candidates,
                    total_candidates,
                    validation_window,
                    current,
                    claim.run_id,
                    claim.lease_owner,
                    current,
                    current,
                ),
            )
            return updated.rowcount == 1

    def complete(self, claim: JobClaim, output: WorkerOutput, *, now: int | None = None) -> Literal["completed", "cancelled", "lost"]:
        current = epoch_ms() if now is None else now
        if output.run_id != claim.run_id or output.status != "completed":
            raise ValueError("completed output run/status mismatch")
        if output.engine_version != claim.engine_version or output.job_kind.value != claim.job_kind:
            raise ValueError("completed output engine/job mismatch")
        content, checksum, uncompressed_size = encode_artifact(output)
        with self.pool.connection() as connection, connection.transaction():
            row = connection.execute(
                """
                SELECT job.state, job.lease_owner, job.lease_expires_at,
                       job.deadline_at, run.status AS run_status
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.run_id = %s
                FOR UPDATE OF job, run
                """,
                (claim.run_id,),
            ).fetchone()
            if (
                not row
                or row["state"] != "running"
                or row["lease_owner"] != claim.lease_owner
                or int(row["lease_expires_at"] or 0) <= current
                or int(row["deadline_at"]) <= current
            ):
                return "lost"
            if row["run_status"] == "cancel_requested":
                self._cancel(connection, claim.run_id, current, "worker_observed_cancellation")
                return "cancelled"
            if row["run_status"] != "running":
                return "lost"
            artifact_id = str(uuid4())
            inserted = connection.execute(
                """
                INSERT INTO portfolio_worker_artifacts (
                  artifact_id, run_id, artifact_role, format, content_encoding, content,
                  byte_count, uncompressed_byte_count, checksum, schema_version,
                  data_revision, created_at
                ) VALUES (%s, %s, 'output', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(run_id, artifact_role) DO NOTHING
                """,
                (
                    artifact_id,
                    claim.run_id,
                    ARTIFACT_FORMAT,
                    ARTIFACT_ENCODING,
                    content,
                    len(content),
                    uncompressed_size,
                    checksum,
                    SCHEMA_VERSION,
                    claim.data_revision,
                    current,
                ),
            )
            if inserted.rowcount != 1:
                existing = connection.execute(
                    """
                    SELECT artifact_id, checksum, data_revision FROM portfolio_worker_artifacts
                    WHERE run_id = %s AND artifact_role = 'output'
                    """,
                    (claim.run_id,),
                ).fetchone()
                if not existing or existing["checksum"] != checksum or existing["data_revision"] != claim.data_revision:
                    raise RuntimeError("immutable worker output artifact conflict")
                artifact_id = existing["artifact_id"]
            run_update = connection.execute(
                """
                UPDATE portfolio_backtest_runs
                SET status = 'completed', progress = 1, summary_json = %s, result_json = %s,
                    warnings_json = %s, error_json = NULL, finished_at = %s, updated_at = %s
                WHERE run_id = %s AND status = 'running'
                """,
                (
                    json_text(output.summary),
                    json_text(output.result),
                    json_text(output.warnings),
                    current,
                    current,
                    claim.run_id,
                ),
            )
            job_update = connection.execute(
                """
                UPDATE portfolio_run_jobs
                SET state = 'completed', result_artifact_id = %s, lease_owner = NULL,
                    lease_expires_at = NULL, heartbeat_at = %s, finished_at = %s, updated_at = %s
                WHERE run_id = %s AND state = 'running' AND lease_owner = %s
                """,
                (artifact_id, current, current, current, claim.run_id, claim.lease_owner),
            )
            if run_update.rowcount != 1 or job_update.rowcount != 1:
                raise RuntimeError("worker completion state transition conflict")
            self._event(
                connection,
                claim.run_id,
                "worker_completed",
                {"result_artifact_id": artifact_id, "checksum": checksum},
                current,
            )
            return "completed"

    def fail(
        self,
        claim: JobClaim,
        error: dict[str, Any],
        *,
        retryable: bool,
        retry_delay_ms: int = 0,
        now: int | None = None,
    ) -> Literal["requeued", "failed", "cancelled", "lost"]:
        current = epoch_ms() if now is None else now
        with self.pool.connection() as connection, connection.transaction():
            row = connection.execute(
                """
                SELECT job.state, job.lease_owner, job.lease_expires_at, job.deadline_at,
                       job.attempt_count, job.max_attempts,
                       run.status AS run_status
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.run_id = %s
                FOR UPDATE OF job, run
                """,
                (claim.run_id,),
            ).fetchone()
            if (
                not row
                or row["state"] != "running"
                or row["lease_owner"] != claim.lease_owner
                or int(row["lease_expires_at"] or 0) <= current
                or int(row["deadline_at"]) <= current
            ):
                return "lost"
            if row["run_status"] == "cancel_requested":
                self._cancel(connection, claim.run_id, current, "worker_observed_cancellation")
                return "cancelled"
            if retryable and int(row["attempt_count"]) < int(row["max_attempts"]):
                connection.execute(
                    """
                    UPDATE portfolio_run_jobs
                    SET state = 'queued', available_at = %s, lease_owner = NULL,
                        lease_expires_at = NULL, heartbeat_at = NULL,
                        last_error_json = %s, updated_at = %s
                    WHERE run_id = %s AND state = 'running' AND lease_owner = %s
                    """,
                    (current + max(0, retry_delay_ms), json_text(error), current, claim.run_id, claim.lease_owner),
                )
                connection.execute(
                    """
                    UPDATE portfolio_backtest_runs
                    SET status = 'queued', progress = 0, completed_candidates = 0,
                        current_validation_window = NULL, error_json = %s, updated_at = %s
                    WHERE run_id = %s AND status = 'running'
                    """,
                    (json_text(error), current, claim.run_id),
                )
                self._event(connection, claim.run_id, "worker_requeued", {"error": error}, current)
                return "requeued"
            self._fail(connection, claim.run_id, error, current, "worker_failed")
            return "failed"

    def expire_deadline(
        self,
        claim: JobClaim,
        *,
        now: int | None = None,
    ) -> Literal["failed", "cancelled", "lost"]:
        current = epoch_ms() if now is None else now
        with self.pool.connection() as connection, connection.transaction():
            row = connection.execute(
                """
                SELECT job.state, job.lease_owner, job.deadline_at, run.status AS run_status
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.run_id = %s
                FOR UPDATE OF job, run
                """,
                (claim.run_id,),
            ).fetchone()
            if (
                not row
                or row["state"] != "running"
                or row["lease_owner"] != claim.lease_owner
                or int(row["deadline_at"]) > current
            ):
                return "lost"
            if row["run_status"] == "cancel_requested":
                self._cancel(connection, claim.run_id, current, "deadline_cancellation_observed")
                return "cancelled"
            self._fail(
                connection,
                claim.run_id,
                {
                    "code": "RUN_DEADLINE_EXCEEDED",
                    "message": "external compute job absolute deadline exceeded",
                    "retryable": True,
                },
                current,
                "worker_deadline_exceeded",
            )
            return "failed"

    def recover_expired(self, *, now: int | None = None, limit: int = 100) -> dict[str, int]:
        current = epoch_ms() if now is None else now
        safe_limit = max(1, min(1_000, int(limit)))
        counts = {"requeued": 0, "failed": 0, "cancelled": 0}
        with self.pool.connection() as connection, connection.transaction():
            deadline_rows = connection.execute(
                f"""
                SELECT job.run_id, run.status AS run_status
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.state IN ('queued', 'running') AND job.deadline_at <= %s
                ORDER BY job.deadline_at ASC
                FOR UPDATE OF job, run SKIP LOCKED
                LIMIT {safe_limit}
                """,
                (current,),
            ).fetchall()
            for row in deadline_rows:
                if row["run_status"] == "cancel_requested":
                    self._cancel(connection, row["run_id"], current, "deadline_cancellation_observed")
                    counts["cancelled"] += 1
                else:
                    self._fail(
                        connection,
                        row["run_id"],
                        {
                            "code": "RUN_DEADLINE_EXCEEDED",
                            "message": "external compute job absolute deadline exceeded",
                            "retryable": True,
                        },
                        current,
                        "worker_deadline_exceeded",
                    )
                    counts["failed"] += 1
            remaining = safe_limit - len(deadline_rows)
            if remaining <= 0:
                return counts
            rows = connection.execute(
                f"""
                SELECT job.run_id, job.attempt_count, job.max_attempts,
                       run.status AS run_status
                FROM portfolio_run_jobs job
                JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
                WHERE job.state = 'running' AND job.lease_expires_at <= %s
                  AND job.deadline_at > %s
                ORDER BY job.lease_expires_at ASC
                FOR UPDATE OF job, run SKIP LOCKED
                LIMIT {remaining}
                """,
                (current, current),
            ).fetchall()
            for row in rows:
                if row["run_status"] == "cancel_requested":
                    self._cancel(connection, row["run_id"], current, "expired_lease_cancelled")
                    counts["cancelled"] += 1
                elif int(row["attempt_count"]) < int(row["max_attempts"]):
                    connection.execute(
                        """
                        UPDATE portfolio_run_jobs
                        SET state = 'queued', available_at = %s, lease_owner = NULL,
                            lease_expires_at = NULL, heartbeat_at = NULL, updated_at = %s
                        WHERE run_id = %s AND state = 'running'
                        """,
                        (current, current, row["run_id"]),
                    )
                    connection.execute(
                        """
                        UPDATE portfolio_backtest_runs
                        SET status = 'queued', progress = 0, completed_candidates = 0,
                            current_validation_window = NULL, updated_at = %s
                        WHERE run_id = %s AND status = 'running'
                        """,
                        (current, row["run_id"]),
                    )
                    self._event(
                        connection,
                        row["run_id"],
                        "expired_lease_requeued",
                        {"attempt_count": int(row["attempt_count"]), "max_attempts": int(row["max_attempts"])},
                        current,
                    )
                    counts["requeued"] += 1
                else:
                    self._fail(
                        connection,
                        row["run_id"],
                        {
                            "code": "WORKER_LEASE_EXHAUSTED",
                            "message": "worker lease expired too many times",
                            "retryable": True,
                        },
                        current,
                        "expired_lease_failed",
                    )
                    counts["failed"] += 1
        return counts

    @staticmethod
    def _event(connection: Any, run_id: str, event_type: str, detail: dict[str, Any], now: int) -> None:
        connection.execute(
            """
            INSERT INTO portfolio_run_events (event_id, run_id, event_type, event_json, created_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (str(uuid4()), run_id, event_type[:64], json_text(detail), now),
        )

    @classmethod
    def _cancel(cls, connection: Any, run_id: str, now: int, event_type: str) -> None:
        connection.execute(
            """
            UPDATE portfolio_run_jobs
            SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                heartbeat_at = NULL, finished_at = %s, updated_at = %s
            WHERE run_id = %s AND state IN ('queued', 'running')
            """,
            (now, now, run_id),
        )
        connection.execute(
            """
            UPDATE portfolio_backtest_runs
            SET status = 'cancelled', summary_json = %s, warnings_json = %s,
                finished_at = %s, updated_at = %s
            WHERE run_id = %s AND status IN ('queued', 'running', 'cancel_requested')
            """,
            (json_text({"cancelled": True}), json_text(["사용자 요청으로 실행을 취소했습니다."]), now, now, run_id),
        )
        cls._event(connection, run_id, event_type, {}, now)

    @classmethod
    def _fail(cls, connection: Any, run_id: str, error: dict[str, Any], now: int, event_type: str) -> None:
        connection.execute(
            """
            UPDATE portfolio_run_jobs
            SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                heartbeat_at = NULL, last_error_json = %s, finished_at = %s, updated_at = %s
            WHERE run_id = %s AND state IN ('queued', 'running')
            """,
            (json_text(error), now, now, run_id),
        )
        connection.execute(
            """
            UPDATE portfolio_backtest_runs
            SET status = 'failed', error_json = %s, warnings_json = %s,
                finished_at = %s, updated_at = %s
            WHERE run_id = %s AND status IN ('queued', 'running', 'cancel_requested')
            """,
            (json_text(error), json_text(["중단 전 저장된 artifact는 보존되었습니다."]), now, now, run_id),
        )
        cls._event(connection, run_id, event_type, {"error": error}, now)
