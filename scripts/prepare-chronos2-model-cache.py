#!/usr/bin/env python3
"""Prepare or verify the pinned offline amazon/chronos-2 snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

SCHEMA_VERSION = "scalping-ai-model-manifest/v2"
FOLDER = "chronos-2"
REQUIRED_FILES = ("config.json", "model.safetensors")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=(
            Path(__file__).resolve().parents[1]
            / "worker"
            / "ai"
            / "model-manifest.json"
        ),
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def load_pin(path: Path) -> tuple[dict[str, object], dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    source = payload.get("chronos2_source")
    model = payload.get("models", {}).get("chronos-2")
    if (
        payload.get("schema_version") != SCHEMA_VERSION
        or not isinstance(source, dict)
        or source.get("package") != "chronos-forecasting"
        or source.get("version") != "2.3.1"
        or source.get("revision") != "v2.3.1"
        or not isinstance(model, dict)
        or model.get("model_id") != "amazon/chronos-2"
        or model.get("revision")
        != "254b5357164a84326913b0695216f690752ac55d"
        or model.get("checkpoint_file") != "model.safetensors"
        or model.get("checkpoint_sha256")
        != "ddcda3c7508bf2528087723e98a20707cc04b7f370ae275a9fd88078ddba4f42"
    ):
        raise RuntimeError("Chronos-2 manifest pins differ from the reviewed release")
    return source, model


def verify_config(path: Path, model: dict[str, object]) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    chronos = value.get("chronos_config") if isinstance(value, dict) else None
    if (
        not isinstance(chronos, dict)
        or value.get("architectures") != ["Chronos2Model"]
        or value.get("chronos_pipeline_class") != "Chronos2Pipeline"
        or value.get("torch_dtype") != "float32"
        or value.get("d_model") != 768
        or value.get("d_ff") != 3072
        or value.get("num_heads") != 12
        or value.get("num_layers") != 12
        or chronos.get("context_length") != model.get("context_length")
        or chronos.get("input_patch_size") != model.get("input_patch_size")
        or chronos.get("input_patch_stride") != 16
        or chronos.get("output_patch_size") != model.get("output_patch_size")
        or chronos.get("max_output_patches") != model.get("max_output_patches")
        or chronos.get("quantiles") != model.get("native_quantiles")
        or chronos.get("time_encoding_scale") != 8192
        or chronos.get("use_arcsinh") is not True
        or chronos.get("use_reg_token") is not True
    ):
        raise RuntimeError("Chronos-2 config does not match the reviewed architecture")


def verify_snapshot(snapshot: Path, model: dict[str, object]) -> None:
    if snapshot.is_symlink() or not snapshot.is_dir():
        raise RuntimeError("Chronos-2 snapshot directory is unavailable or a symlink")
    for name in REQUIRED_FILES:
        path = snapshot / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"Chronos-2 required file is unavailable: {name}")
    marker = snapshot / ".revision"
    if (
        marker.is_symlink()
        or not marker.is_file()
        or marker.read_text(encoding="utf-8").strip() != model["revision"]
    ):
        raise RuntimeError("Chronos-2 revision marker is invalid")
    if sha256_file(snapshot / "model.safetensors") != model["checkpoint_sha256"]:
        raise RuntimeError("Chronos-2 weight SHA-256 differs from the pinned manifest")
    verify_config(snapshot / "config.json", model)


def write_marker(snapshot: Path, revision: str) -> None:
    temporary = snapshot / f".revision.tmp-{os.getpid()}"
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(f"{revision}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, snapshot / ".revision")


def make_read_only(snapshot: Path) -> None:
    for name in (*REQUIRED_FILES, ".revision"):
        (snapshot / name).chmod(0o444)
    snapshot.chmod(0o555)


def download(
    cache_dir: Path,
    model: dict[str, object],
) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "huggingface-hub is required only for this explicit provisioning step"
        ) from error
    cache_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    destination = cache_dir / FOLDER
    if destination.exists() or destination.is_symlink():
        verify_snapshot(destination, model)
        make_read_only(destination)
        return destination
    temporary = cache_dir / f".{FOLDER}.download-{uuid.uuid4().hex}"
    temporary.mkdir(mode=0o700)
    try:
        snapshot_download(
            repo_id=str(model["model_id"]),
            revision=str(model["revision"]),
            local_dir=temporary,
            allow_patterns=list(REQUIRED_FILES),
        )
        write_marker(temporary, str(model["revision"]))
        verify_snapshot(temporary, model)
        make_read_only(temporary)
        temporary.chmod(0o755)
        os.replace(temporary, destination)
        destination.chmod(0o555)
    except BaseException:
        try:
            temporary.chmod(0o700)
        except OSError:
            pass
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return destination


def main() -> int:
    arguments = parse_args()
    manifest = arguments.manifest.resolve(strict=True)
    cache_dir = arguments.cache_dir.expanduser().resolve()
    _source, model = load_pin(manifest)
    destination = cache_dir / FOLDER
    if not arguments.check_only:
        destination = download(cache_dir, model)
    verify_snapshot(destination, model)
    print(
        json.dumps(
            {
                "schema_version": "chronos2-model-cache/v1",
                "model_id": model["model_id"],
                "revision": model["revision"],
                "checkpoint_sha256": model["checkpoint_sha256"],
                "snapshot": str(destination),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Chronos-2 cache preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
