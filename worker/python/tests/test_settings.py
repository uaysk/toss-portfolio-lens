from __future__ import annotations

from pathlib import Path

import pytest
from psycopg.conninfo import conninfo_to_dict

from portfolio_worker.settings import WorkerSettings


def test_postgres_url_is_augmented_with_worker_timeout_and_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_URL", "postgresql://portfolio:password@postgres.internal:5432/portfolio_lens")
    monkeypatch.setenv("POSTGRES_CONNECT_TIMEOUT_SECONDS", "7")
    monkeypatch.setenv("CLIENT_SECRET", "must-not-be-consumed")
    settings = WorkerSettings.from_env()
    parsed = conninfo_to_dict(settings.conninfo)
    assert parsed["host"] == "postgres.internal"
    assert parsed["connect_timeout"] == "7"
    assert parsed["application_name"] == "toss-portfolio-lens-python-worker"
    assert "must-not-be-consumed" not in settings.conninfo
    assert set(settings.__dataclass_fields__) == {
        "conninfo",
        "worker_id",
        "poll_ms",
        "lease_ms",
        "heartbeat_ms",
        "recovery_ms",
        "candidate_batch_size",
    }


def test_tls_ca_forces_verify_full(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ca_path = tmp_path / "postgres-ca.crt"
    ca_path.write_text("test-ca", encoding="utf-8")
    monkeypatch.setenv("POSTGRES_URL", "postgresql://portfolio:password@postgres.internal:5432/portfolio_lens")
    monkeypatch.setenv("POSTGRES_SSL", "true")
    monkeypatch.setenv("POSTGRES_SSL_CA_PATH", str(ca_path))
    parsed = conninfo_to_dict(WorkerSettings.from_env().conninfo)
    assert parsed["sslmode"] == "verify-full"
    assert parsed["sslrootcert"] == str(ca_path)


def test_heartbeat_must_leave_time_for_lease_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_URL", "postgresql://portfolio:password@postgres.internal:5432/portfolio_lens")
    monkeypatch.setenv("PYTHON_WORKER_LEASE_MS", "5000")
    monkeypatch.setenv("PYTHON_WORKER_HEARTBEAT_MS", "2500")
    with pytest.raises(ValueError, match="less than half"):
        WorkerSettings.from_env()
