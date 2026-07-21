#!/usr/bin/env python3
"""Prepare or verify the pinned Chronos-Bolt fallback snapshot.

This is an explicit operator action. The production image remains offline and
never invokes this script or downloads model files at runtime.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import uuid


SCHEMA_VERSION = "scalping-ai-model-manifest/v1"
MODEL_NAME = "chronos-bolt-small"
REQUIRED_FILES = ("config.json", "model.safetensors")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "worker"
        / "ai"
        / "model-manifest.json",
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="verify an existing snapshot without accessing the network",
    )
    return parser.parse_args()


def load_pinned_model(manifest_path: Path) -> tuple[str, str]:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise RuntimeError(
            f"unexpected model manifest schema: {payload.get('schema_version')!r}"
        )
    model = payload.get("models", {}).get(MODEL_NAME)
    if not isinstance(model, dict):
        raise RuntimeError(f"{MODEL_NAME} is missing from {manifest_path}")
    model_id = model.get("model_id")
    revision = model.get("revision")
    if (
        not isinstance(model_id, str)
        or not model_id
        or not isinstance(revision, str)
        or not revision
    ):
        raise RuntimeError(f"{MODEL_NAME} has an incomplete pinned manifest entry")
    return model_id, revision


def verify_snapshot(snapshot: Path, revision: str) -> None:
    if snapshot.is_symlink() or not snapshot.is_dir():
        raise RuntimeError(
            f"snapshot directory is unavailable or is a symlink: {snapshot}"
        )
    for relative in REQUIRED_FILES:
        candidate = snapshot / relative
        if (
            candidate.is_symlink()
            or not candidate.is_file()
            or candidate.stat().st_size <= 0
        ):
            raise RuntimeError(f"required regular file is unavailable: {candidate}")
    config = json.loads((snapshot / "config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise RuntimeError("config.json must contain a JSON object")
    marker = snapshot / ".revision"
    if marker.is_symlink() or not marker.is_file():
        raise RuntimeError(f"revision marker is unavailable: {marker}")
    if marker.read_text(encoding="utf-8").strip() != revision:
        raise RuntimeError(
            "snapshot revision marker does not match the pinned manifest"
        )


def write_revision_marker(snapshot: Path, revision: str) -> None:
    marker = snapshot / ".revision"
    temporary = snapshot / f".revision.tmp-{os.getpid()}"
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(f"{revision}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, marker)


def make_runtime_readable(snapshot: Path) -> None:
    # The runtime container intentionally uses the fixed, unprivileged UID 10001.
    # These are public model artifacts, not credentials, so immutable-style read
    # permissions are preferable to coupling the cache to a host account UID.
    for relative in (*REQUIRED_FILES, ".revision"):
        (snapshot / relative).chmod(0o444)
    snapshot.chmod(0o555)


def download_snapshot(cache_dir: Path, model_id: str, revision: str) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "huggingface-hub is required for the explicit preparation step; "
            "run through the pinned uv command documented in worker/ai/README.md"
        ) from error

    cache_created = not cache_dir.exists()
    cache_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    if cache_created:
        cache_dir.chmod(0o755)
    destination = cache_dir / MODEL_NAME
    if destination.exists() or destination.is_symlink():
        verify_snapshot(destination, revision)
        make_runtime_readable(destination)
        return destination

    temporary = cache_dir / f".{MODEL_NAME}.download-{uuid.uuid4().hex}"
    temporary.mkdir(mode=0o700)
    try:
        snapshot_download(
            repo_id=model_id,
            revision=revision,
            local_dir=temporary,
            allow_patterns=list(REQUIRED_FILES),
        )
        write_revision_marker(temporary, revision)
        verify_snapshot(temporary, revision)
        make_runtime_readable(temporary)
        os.replace(temporary, destination)
    except BaseException:
        try:
            temporary.chmod(0o700)
        except OSError:
            pass
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return destination


def main() -> int:
    args = parse_args()
    manifest = args.manifest.resolve(strict=True)
    cache_dir = args.cache_dir.expanduser().resolve()
    model_id, revision = load_pinned_model(manifest)
    destination = cache_dir / MODEL_NAME
    if args.check_only:
        verify_snapshot(destination, revision)
    else:
        destination = download_snapshot(cache_dir, model_id, revision)
    verify_snapshot(destination, revision)
    print(f"verified {model_id}@{revision} in {destination}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"model cache preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
