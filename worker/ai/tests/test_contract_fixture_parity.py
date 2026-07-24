from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.contracts import AI_REQUEST_ADAPTER


FIXTURE_ROOT = Path(__file__).resolve().parents[3] / "contracts" / "scalping-ai"
VALID_ROOT = FIXTURE_ROOT / "valid"
INVALID_ROOT = FIXTURE_ROOT / "invalid"


def _json_files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _at_path(root: Any, path: list[str | int]) -> Any:
    current = root
    for part in path:
        current = current[part]
    return current


def _materialize_invalid_fixture(path: Path) -> Any:
    fixture = _read_json(path)
    request = copy.deepcopy(_read_json(VALID_ROOT / fixture["base"]))
    mutation = fixture["mutation"]
    target_path = mutation["path"]
    operation = mutation["op"]

    if operation == "set":
        parent = _at_path(request, target_path[:-1])
        parent[target_path[-1]] = mutation["value"]
    elif operation == "remove_last":
        _at_path(request, target_path).pop()
    elif operation == "duplicate_item":
        target = _at_path(request, target_path)
        target.append(copy.deepcopy(target[mutation["index"]]))
    else:
        raise AssertionError(f"{path.name}: unsupported fixture mutation {operation}")
    return request


@pytest.mark.parametrize("path", _json_files(VALID_ROOT), ids=lambda path: path.name)
def test_shared_valid_contract_fixture_is_accepted(path: Path) -> None:
    AI_REQUEST_ADAPTER.validate_json(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", _json_files(INVALID_ROOT), ids=lambda path: path.name)
def test_shared_invalid_contract_fixture_is_rejected(path: Path) -> None:
    request = _materialize_invalid_fixture(path)
    with pytest.raises(ValidationError):
        AI_REQUEST_ADAPTER.validate_json(json.dumps(request))


def test_shared_contract_fixture_inventory_matches_typescript_parity_suite() -> None:
    assert [path.name for path in _json_files(VALID_ROOT)] == ["evaluate.json", "forecast.json"]
    assert [path.name for path in _json_files(INVALID_ROOT)] == [
        "completed-bar.json",
        "duplicate-instrument-key.json",
        "evaluation-consecutive-future-bars.json",
        "evaluation-origin.json",
        "fixed-horizons.json",
        "fixed-quantiles.json",
        "future-timestamp-count.json",
        "input-end-at.json",
        "schema-version.json",
        "strictly-increasing-bars.json",
        "target-stop-bounds.json",
        "timezone-aware-timestamp.json",
        "unknown-field.json",
    ]
