from __future__ import annotations

import pytest

from portfolio_worker.contracts import JobKind, WorkerInput, canonical_json, decode_artifact, encode_artifact
from portfolio_worker.compute import compute_worker_input


def input_value() -> WorkerInput:
    return WorkerInput.model_validate(
        {
            "schema_version": "1.0",
            "engine_version": "test-v1",
            "run_id": "run-1",
            "job_kind": JobKind.BACKTEST,
            "data_revision": "revision-1",
            "request_hash": "a" * 64,
            "payload": {"z": 2, "a": {"y": 1, "x": [3, 2, 1]}},
        }
    )


def test_artifact_round_trip_and_canonical_order() -> None:
    value = input_value()
    content, checksum, source_size = encode_artifact(value)
    decoded = decode_artifact(content, checksum, expect_input=True)
    assert decoded == value
    assert source_size == len(canonical_json(value))
    assert canonical_json(value).index(b'"a"') < canonical_json(value).index(b'"z"')


def test_canonical_order_is_stable_for_unicode_normalization_variants() -> None:
    left = {"é": 1, "é": 2}
    right = {"é": 2, "é": 1}
    assert canonical_json(left) == canonical_json(right)


def test_artifact_checksum_rejects_tampering() -> None:
    content, _, _ = encode_artifact(input_value())
    with pytest.raises(ValueError, match="checksum"):
        decode_artifact(content, "0" * 64, expect_input=True)


def test_compute_rejects_unsupported_engine_version() -> None:
    with pytest.raises(ValueError, match="unsupported engine version"):
        compute_worker_input(input_value(), candidate_batch_size=8)
