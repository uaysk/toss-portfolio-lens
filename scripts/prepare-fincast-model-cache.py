#!/usr/bin/env python3
"""Convert the pinned FinCast pickle checkpoint into offline safetensors.

This is an isolated provisioning action. Runtime images never execute this
script, load pickle, or access the network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
from typing import Any
import uuid

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "worker" / "ai" / "src"))

from portfolio_ai_worker.fincast import (  # noqa: E402
    import_decoder_from_source,
    is_fincast_fp32_island_key,
    verify_pinned_attention_softmax_structure,
)

MANIFEST_SCHEMA = "scalping-ai-model-manifest/v2"
SOURCE_REVISION = "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4"
SOURCE_ARCHIVE_SHA256 = "ed4c3967c6d548465307fc0b63895ac9c9d8b44a950ccf936ab97e1755451a91"
MODEL_REVISION = "2d7d90b159db8961d27c2cf165d51195902ef92b"
CHECKPOINT_SHA256 = "d5ca999b02c944effa60d2b94174dc4d5a0cd2c0543ae289b2e36f37431492a8"
SOURCE_FILES = (
    "LICENSE",
    "src/ffm/__init__.py",
    "src/ffm/pytorch_patched_decoder_MOE.py",
    "src/st_moe_pytorch/__init__.py",
    "src/st_moe_pytorch/st_moe_pytorch.py",
    "src/st_moe_pytorch/distributed.py",
)
SOURCE_FILE_SHA256 = {
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "src/ffm/__init__.py": "d34f04310fbc42fb6a35d1b0cb033356da617a8cbbd5a3228f07e3089c379434",
    "src/ffm/pytorch_patched_decoder_MOE.py": "58c8d5dfea859c87958e1b35fa2b2eb9c9a1d8bd99813be528adbdaf37c15dbe",
    "src/st_moe_pytorch/__init__.py": "5d67d4f81d080199049af3217f947fa1e6de83671675e1543801995f4c602553",
    "src/st_moe_pytorch/st_moe_pytorch.py": "c38a8789120f6d5009be4fd91cce1a9d75011adb1ddb73f45060b99f0d7ae477",
    "src/st_moe_pytorch/distributed.py": "3a3742c3389be59305c3eb22e88cbaef3fcfec514687856b7b1954a3a5db129a",
}
ARTIFACTS = ("model.fp32.safetensors", "model.mixed-fp16.safetensors")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "worker" / "ai" / "model-manifest.json",
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != MANIFEST_SCHEMA:
        raise RuntimeError("unexpected model manifest schema")
    source = payload.get("fincast_source")
    model = payload.get("models", {}).get("fincast")
    if (
        not isinstance(source, dict)
        or source.get("revision") != SOURCE_REVISION
        or source.get("archive_sha256") != SOURCE_ARCHIVE_SHA256
        or source.get("required_file_sha256") != SOURCE_FILE_SHA256
        or not isinstance(model, dict)
        or model.get("revision") != MODEL_REVISION
        or model.get("checkpoint_sha256") != CHECKPOINT_SHA256
    ):
        raise RuntimeError("FinCast manifest pins do not match the reviewed release")
    return source, model


def _safe_archive_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    for member in members:
        relative = PurePosixPath(member.name)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("FinCast source archive contains an unsafe path")
        if member.issym() or member.islnk() or member.isdev():
            raise RuntimeError("FinCast source archive contains a link or device")
    return members


def extract_source(archive_path: Path, destination: Path) -> Path:
    if sha256_file(archive_path) != SOURCE_ARCHIVE_SHA256:
        raise RuntimeError("FinCast source archive SHA-256 does not match the manifest")
    with tarfile.open(archive_path, mode="r:*") as archive:
        members = _safe_archive_members(archive)
        archive.extractall(destination, members=members, filter="data")
    candidates = [
        path.parents[2]
        for path in destination.rglob("src/ffm/pytorch_patched_decoder_MOE.py")
        if all((path.parents[2] / relative).is_file() for relative in SOURCE_FILES)
    ]
    if len(candidates) != 1:
        raise RuntimeError("FinCast source archive does not contain one reviewed source root")
    for relative, expected in SOURCE_FILE_SHA256.items():
        if sha256_file(candidates[0] / relative) != expected:
            raise RuntimeError(f"FinCast reviewed source file SHA-256 mismatch: {relative}")
    return candidates[0]


def normalize_state_dict(value: object, torch: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not value:
        raise RuntimeError("FinCast checkpoint must be a non-empty tensor state dict")
    normalized: dict[str, Any] = {}
    prefixes = ("_orig_mod.module.", "_orig_mod.", "module.")
    for raw_key, tensor in value.items():
        if not isinstance(raw_key, str) or not raw_key or len(raw_key) > 512:
            raise RuntimeError("FinCast checkpoint contains an invalid state key")
        key = raw_key
        for prefix in prefixes:
            if key.startswith(prefix):
                key = key[len(prefix) :]
                break
        if key in normalized:
            raise RuntimeError("FinCast checkpoint key normalization produced a duplicate")
        if not isinstance(tensor, torch.Tensor):
            raise RuntimeError("FinCast checkpoint contains a non-tensor value")
        if tensor.layout != torch.strided or tensor.is_sparse or tensor.ndim > 8:
            raise RuntimeError(f"FinCast checkpoint tensor layout is unsupported: {key}")
        if any(dimension <= 0 for dimension in tensor.shape):
            raise RuntimeError(f"FinCast checkpoint tensor has an invalid shape: {key}")
        normalized[key] = tensor.detach().cpu().contiguous()
    return normalized


def expected_state_dict(source_root: Path, torch: Any) -> dict[str, Any]:
    source_path = str(source_root / "src")
    sys.path.insert(0, source_path)
    try:
        decoder = import_decoder_from_source(source_root)
        with torch.device("meta"):
            model = decoder.PatchedTimeSeriesDecoder_MOE(
                decoder.FFMConfig(num_experts=4, gating_top_n=2)
            )
        return dict(model.state_dict())
    finally:
        sys.path.remove(source_path)


def validate_state_dict(state: dict[str, Any], expected: dict[str, Any], torch: Any) -> None:
    if set(state) != set(expected):
        missing = sorted(set(expected) - set(state))[:3]
        extra = sorted(set(state) - set(expected))[:3]
        raise RuntimeError(f"FinCast checkpoint keys differ from reviewed architecture: missing={missing}, extra={extra}")
    for key, tensor in state.items():
        reference = expected[key]
        if tuple(tensor.shape) != tuple(reference.shape):
            raise RuntimeError(f"FinCast checkpoint shape differs from reviewed architecture: {key}")
        if reference.dtype.is_floating_point:
            if tensor.dtype != torch.float32:
                raise RuntimeError(f"FinCast original floating tensor is not FP32: {key}")
        elif tensor.dtype != reference.dtype:
            raise RuntimeError(f"FinCast checkpoint dtype differs from reviewed architecture: {key}")


def mixed_state_dict(state: dict[str, Any], torch: Any) -> dict[str, Any]:
    return {
        key: (
            tensor
            if not tensor.dtype.is_floating_point or is_fincast_fp32_island_key(key)
            else tensor.to(dtype=torch.float16)
        )
        for key, tensor in state.items()
    }


def _write_text(path: Path, value: str) -> None:
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def make_read_only(root: Path) -> None:
    for path in sorted(root.rglob("*"), reverse=True):
        path.chmod(0o555 if path.is_dir() else 0o444)
    root.chmod(0o555)


def remove_read_only_tree(root: Path) -> None:
    if not root.exists():
        return
    root.chmod(0o755)
    for path in root.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            path.chmod(0o755)
    shutil.rmtree(root)


def publish_read_only_cache(
    cache_dir: Path,
    source_stage: Path,
    model_stage: Path,
) -> None:
    final_source = cache_dir / "fincast-source"
    final_model = cache_dir / "fincast"
    published: list[Path] = []
    try:
        make_read_only(source_stage)
        make_read_only(model_stage)
        # Moving a directory to another parent updates its ".." entry on Linux,
        # so the staged roots must remain writable until both atomic renames
        # complete. Descendants are already immutable at this point.
        source_stage.chmod(0o755)
        model_stage.chmod(0o755)
        os.replace(source_stage, final_source)
        published.append(final_source)
        os.replace(model_stage, final_model)
        published.append(final_model)
        final_source.chmod(0o555)
        final_model.chmod(0o555)
    except Exception:
        for root in reversed(published):
            remove_read_only_tree(root)
        raise


def verify_cache(cache_dir: Path) -> None:
    source = cache_dir / "fincast-source"
    model = cache_dir / "fincast"
    if (source / ".source-revision").read_text(encoding="utf-8").strip() != SOURCE_REVISION:
        raise RuntimeError("FinCast source revision marker mismatch")
    if (source / ".source-archive-sha256").read_text(encoding="utf-8").strip() != SOURCE_ARCHIVE_SHA256:
        raise RuntimeError("FinCast source archive marker mismatch")
    if (model / ".revision").read_text(encoding="utf-8").strip() != MODEL_REVISION:
        raise RuntimeError("FinCast model revision marker mismatch")
    hashes = json.loads((model / ".artifact-sha256.json").read_text(encoding="utf-8"))
    for relative in SOURCE_FILES:
        path = source / relative
        if (
            path.is_symlink()
            or not path.is_file()
            or sha256_file(path) != SOURCE_FILE_SHA256[relative]
        ):
            raise RuntimeError(f"FinCast source file is unavailable: {relative}")
    for name in ARTIFACTS:
        path = model / name
        if path.is_symlink() or not path.is_file() or sha256_file(path) != hashes.get(name):
            raise RuntimeError(f"FinCast safetensors verification failed: {name}")


def prepare(cache_dir: Path, source_archive: Path, checkpoint: Path) -> None:
    import torch
    from safetensors.torch import save_file

    if sha256_file(checkpoint) != CHECKPOINT_SHA256:
        raise RuntimeError("FinCast v1.pth SHA-256 does not match the manifest")
    if (cache_dir / "fincast").exists() or (cache_dir / "fincast-source").exists():
        raise RuntimeError("FinCast cache destination already exists; provisioning will not overwrite it")
    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fincast-provision-") as temporary_text:
        temporary = Path(temporary_text)
        extracted = temporary / "source-extract"
        extracted.mkdir()
        source_root = extract_source(source_archive, extracted)
        verify_pinned_attention_softmax_structure(source_root)
        loaded = torch.load(checkpoint, map_location="cpu", weights_only=True)
        state = normalize_state_dict(loaded, torch)
        validate_state_dict(state, expected_state_dict(source_root, torch), torch)

        stage = cache_dir / f".fincast-stage-{uuid.uuid4().hex}"
        source_stage = stage / "fincast-source"
        model_stage = stage / "fincast"
        source_stage.mkdir(parents=True)
        model_stage.mkdir()
        try:
            for relative in SOURCE_FILES:
                destination = source_stage / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source_root / relative, destination)
            _write_text(source_stage / ".source-revision", f"{SOURCE_REVISION}\n")
            _write_text(source_stage / ".source-archive-sha256", f"{SOURCE_ARCHIVE_SHA256}\n")
            _write_text(model_stage / ".revision", f"{MODEL_REVISION}\n")
            metadata = {
                "model_id": "Vincent05R/FinCast",
                "model_revision": MODEL_REVISION,
                "source_revision": SOURCE_REVISION,
                "converted_with_weights_only": "true",
            }
            save_file(state, model_stage / ARTIFACTS[0], metadata={**metadata, "precision": "float32"})
            save_file(
                mixed_state_dict(state, torch),
                model_stage / ARTIFACTS[1],
                metadata={**metadata, "precision": "mixed_float16"},
            )
            hashes = {name: sha256_file(model_stage / name) for name in ARTIFACTS}
            _write_text(
                model_stage / ".artifact-sha256.json",
                json.dumps(hashes, sort_keys=True, separators=(",", ":")) + "\n",
            )
            publish_read_only_cache(cache_dir, source_stage, model_stage)
        finally:
            remove_read_only_tree(stage)
    verify_cache(cache_dir)


def main() -> int:
    args = parse_args()
    load_manifest(args.manifest.resolve(strict=True))
    cache_dir = args.cache_dir.expanduser().resolve()
    if args.check_only:
        verify_cache(cache_dir)
    else:
        if args.source_archive is None or args.checkpoint is None:
            raise RuntimeError("--source-archive and --checkpoint are required unless --check-only is used")
        prepare(
            cache_dir,
            args.source_archive.expanduser().resolve(strict=True),
            args.checkpoint.expanduser().resolve(strict=True),
        )
    print(f"verified pinned FinCast offline cache in {cache_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        print(f"FinCast cache preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
