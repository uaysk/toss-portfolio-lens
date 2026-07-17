from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from psycopg.conninfo import make_conninfo


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _postgres_conninfo() -> str:
    url = os.getenv("POSTGRES_URL") or os.getenv("DATABASE_URL")
    if url:
        if not url.startswith(("postgres://", "postgresql://")):
            raise ValueError("POSTGRES_URL/DATABASE_URL must use postgresql://")
        ssl_enabled = os.getenv("POSTGRES_SSL", "false").lower() in {"1", "true", "yes", "on"}
        ca_path = os.getenv("POSTGRES_SSL_CA_PATH")
        if ca_path and not ssl_enabled:
            raise ValueError("POSTGRES_SSL_CA_PATH requires POSTGRES_SSL=true")
        if ca_path and not Path(ca_path).is_file():
            raise ValueError("POSTGRES_SSL_CA_PATH is not readable")
        return make_conninfo(
            url,
            connect_timeout=_bounded_int("POSTGRES_CONNECT_TIMEOUT_SECONDS", 5, 1, 30),
            application_name="toss-portfolio-lens-python-worker",
            **({"sslmode": "verify-full", "sslrootcert": ca_path} if ssl_enabled and ca_path else {}),
            **({"sslmode": "require"} if ssl_enabled and not ca_path else {}),
        )
    required = {
        "host": os.getenv("POSTGRES_HOST"),
        "port": os.getenv("POSTGRES_PORT", "5432"),
        "user": os.getenv("POSTGRES_USER"),
        "password": os.getenv("POSTGRES_PASSWORD"),
        "dbname": os.getenv("POSTGRES_DATABASE"),
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        raise ValueError(f"missing PostgreSQL settings: {', '.join(missing)}")
    ssl_enabled = os.getenv("POSTGRES_SSL", "false").lower() in {"1", "true", "yes", "on"}
    ca_path = os.getenv("POSTGRES_SSL_CA_PATH")
    if ca_path and not ssl_enabled:
        raise ValueError("POSTGRES_SSL_CA_PATH requires POSTGRES_SSL=true")
    if ca_path and not Path(ca_path).is_file():
        raise ValueError("POSTGRES_SSL_CA_PATH is not readable")
    return make_conninfo(
        **required,
        connect_timeout=_bounded_int("POSTGRES_CONNECT_TIMEOUT_SECONDS", 5, 1, 30),
        application_name="toss-portfolio-lens-python-worker",
        **({"sslmode": "verify-full", "sslrootcert": ca_path} if ssl_enabled and ca_path else {}),
        **({"sslmode": "require"} if ssl_enabled and not ca_path else {}),
    )


@dataclass(frozen=True, slots=True)
class WorkerSettings:
    conninfo: str
    worker_id: str
    poll_ms: int
    lease_ms: int
    heartbeat_ms: int
    recovery_ms: int
    candidate_batch_size: int

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        lease_ms = _bounded_int("PYTHON_WORKER_LEASE_MS", 30_000, 5_000, 600_000)
        heartbeat_ms = _bounded_int("PYTHON_WORKER_HEARTBEAT_MS", 10_000, 1_000, 300_000)
        if heartbeat_ms * 2 >= lease_ms:
            raise ValueError("PYTHON_WORKER_HEARTBEAT_MS must be less than half of PYTHON_WORKER_LEASE_MS")
        configured_id = os.getenv("PYTHON_WORKER_ID", "").strip()
        worker_id = configured_id or f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:8]}"
        return cls(
            conninfo=_postgres_conninfo(),
            worker_id=worker_id[:96],
            poll_ms=_bounded_int("PYTHON_WORKER_POLL_MS", 500, 25, 60_000),
            lease_ms=lease_ms,
            heartbeat_ms=heartbeat_ms,
            recovery_ms=_bounded_int("PYTHON_WORKER_RECOVERY_MS", 15_000, 1_000, 600_000),
            candidate_batch_size=_bounded_int("PYTHON_WORKER_CANDIDATE_BATCH_SIZE", 512, 16, 8_192),
        )
