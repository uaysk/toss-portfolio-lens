from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import MethodType
from typing import Any, Iterator, Sequence

import torch
from torch import nn
from torch.nn import functional as F

from .adapters import load_production_model_suite
from .fincast import FinCastAdapter
from .raw_artifacts import (
    RAW_HORIZONS_MINUTES,
    load_raw_input,
    open_contexts,
    routing_uniforms,
)
from .raw_inference import (
    RAW_EXPERTS,
    RAW_MIN_EXPERT_CAPACITY,
    RAW_PATCH_TOKENS,
    RAW_TOP_N,
    FinCastRawInference,
    RawInferenceError,
    RoutingCursor,
)
from .settings import AISettings

TENSORRT_ONNX_OPSET = 17
TENSORRT_ROUTE_PLUGIN_NAME = "FincastTop2Route"
TENSORRT_ROUTE_PLUGIN_VERSION = "1"


class _TensorRTRoute(torch.autograd.Function):
    """PyTorch oracle with a TensorRT custom-plugin ONNX symbolic."""

    @staticmethod
    def forward(
        ctx: Any,
        probabilities: torch.Tensor,
        uniforms: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        del ctx
        if (
            probabilities.ndim != 3
            or probabilities.shape[1:] != (RAW_PATCH_TOKENS, RAW_EXPERTS)
            or uniforms.shape != (RAW_TOP_N, probabilities.shape[0], RAW_PATCH_TOKENS)
        ):
            raise RawInferenceError("TensorRT routing export received an invalid static shape")
        top_values, top_indices = torch.topk(
            probabilities,
            k=RAW_TOP_N,
            dim=-1,
        )
        top_values = top_values / top_values.sum(dim=-1, keepdim=True).clamp(min=1e-9)
        gates = top_values.permute(2, 0, 1)
        indices = top_indices.permute(2, 0, 1)
        mask = F.one_hot(indices, num_classes=RAW_EXPERTS).float()
        threshold = probabilities.new_tensor((1e-9, 0.2)).view(RAW_TOP_N, 1, 1)
        should_route = uniforms < (gates / threshold)
        should_route = torch.cat(
            (
                torch.ones_like(should_route[0:1], dtype=torch.bool),
                should_route[1:],
            ),
            dim=0,
        )
        mask = mask * should_route.unsqueeze(-1).to(mask.dtype)
        mask_cumsum = torch.cumsum(mask, dim=-2) - mask
        expert_capacity = max(
            RAW_MIN_EXPERT_CAPACITY,
            RAW_PATCH_TOKENS * 2 // RAW_EXPERTS,
        )
        routed_masks: list[torch.Tensor] = []
        positions: list[torch.Tensor] = []
        previous_expert_count: torch.Tensor | float = 0.0
        for route_index in range(RAW_TOP_N):
            position_in_expert = (
                mask_cumsum[route_index] + previous_expert_count
            ) * mask[route_index]
            routed_mask = mask[route_index] * (
                position_in_expert < float(expert_capacity)
            ).to(mask.dtype)
            previous_expert_count = (
                routed_mask.sum(dim=-2, keepdim=True) + previous_expert_count
            )
            routed_masks.append(routed_mask)
            positions.append(position_in_expert.sum(dim=-1))
        routed_mask = torch.stack(routed_masks)
        position_tensor = torch.stack(positions)
        mask_flat = routed_mask.sum(dim=-1)
        weighted_gates = gates * mask_flat
        position_one_hot = F.one_hot(
            position_tensor.long(),
            num_classes=RAW_PATCH_TOKENS * RAW_TOP_N + 1,
        )[..., :expert_capacity]
        combine = (
            weighted_gates.unsqueeze(-1).unsqueeze(-1)
            * mask_flat.unsqueeze(-1).unsqueeze(-1)
            * F.one_hot(indices, num_classes=RAW_EXPERTS)
            .to(weighted_gates.dtype)
            .unsqueeze(-1)
            * position_one_hot.to(weighted_gates.dtype).unsqueeze(-2)
        ).sum(dim=0)
        return combine.bool().to(probabilities.dtype), combine

    @staticmethod
    def symbolic(
        graph: Any,
        probabilities: Any,
        uniforms: Any,
    ) -> tuple[Any, Any]:
        dispatch, combine = graph.op(
            TENSORRT_ROUTE_PLUGIN_NAME,
            probabilities,
            uniforms,
            threshold_f=0.2,
            plugin_version_s=TENSORRT_ROUTE_PLUGIN_VERSION,
            plugin_namespace_s="",
            outputs=2,
        )
        return dispatch, combine


def _export_gate_forward(
    gate: Any,
    x: torch.Tensor,
    noise_gates: bool = False,
    noise_mult: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    if noise_gates or noise_mult != 1.0 or gate.training:
        raise RawInferenceError("TensorRT export requires deterministic evaluation routing")
    cursor = getattr(gate, "_fincast_raw_routing_cursor", None)
    if not isinstance(cursor, RoutingCursor):
        raise RawInferenceError("TensorRT export routing values were not installed")
    probabilities = gate.to_gates(x).softmax(dim=-1)
    dispatch, combine = _TensorRTRoute.apply(probabilities, cursor.take(x))
    return dispatch, combine, gate.zero, gate.zero


@contextmanager
def tensorrt_export_routing(gates: Sequence[Any]) -> Iterator[None]:
    originals = tuple(gate.forward for gate in gates)
    try:
        for gate in gates:
            gate.forward = MethodType(_export_gate_forward, gate)
        yield
    finally:
        for gate, original in zip(gates, originals, strict=True):
            gate.forward = original


class StaticRawONNXModule(nn.Module):
    def __init__(self, inference: FinCastRawInference, cadence_seconds: int) -> None:
        super().__init__()
        if inference.backend != "batched_experts":
            raise RawInferenceError("TensorRT export requires the packed-expert backend")
        # Register the exact model tree so the legacy ONNX tracer treats its
        # frozen weights as module parameters instead of grad-requiring constants.
        self.model = inference.model
        self.inference = inference
        self.cadence_seconds = cadence_seconds

    def forward(
        self,
        contexts: torch.Tensor,
        routing_uniforms: torch.Tensor,
    ) -> torch.Tensor:
        return self.inference._predict_no_padding_core(
            contexts,
            routing_uniforms,
            self.cadence_seconds,
        )


def export_static_onnx(
    *,
    inference: FinCastRawInference,
    output_path: Path,
    contexts: torch.Tensor,
    routing_uniforms: torch.Tensor,
    cadence_seconds: int,
) -> None:
    if not output_path.is_absolute() or output_path.resolve(strict=False) != output_path:
        raise RawInferenceError("TensorRT ONNX output must be an absolute normalized path")
    if output_path.exists() or output_path.is_symlink():
        raise RawInferenceError("TensorRT ONNX output already exists")
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    module = StaticRawONNXModule(inference, cadence_seconds).eval()
    with torch.inference_mode(), tensorrt_export_routing(inference.gates):
        torch.onnx.export(
            module,
            (contexts, routing_uniforms),
            str(output_path),
            input_names=("contexts", "routing_uniforms"),
            output_names=("native_predictions",),
            opset_version=TENSORRT_ONNX_OPSET,
            do_constant_folding=True,
            dynamo=False,
            external_data=True,
        )


def export_static_onnx_from_manifest(
    *,
    settings: AISettings,
    manifest_path: Path,
    output_path: Path,
    batch_size: int,
) -> dict[str, Any]:
    if batch_size <= 0:
        raise RawInferenceError("TensorRT ONNX batch size must be positive")
    artifact = load_raw_input(manifest_path)
    if artifact.manifest.row_count < batch_size:
        raise RawInferenceError("TensorRT ONNX input has fewer rows than the static batch")
    suite = load_production_model_suite(settings)
    if not isinstance(suite.primary, FinCastAdapter):
        raise RawInferenceError("the pinned FinCast adapter is unavailable")
    inference = FinCastRawInference(suite.primary, backend="batched_experts")
    contexts_map = open_contexts(artifact)
    try:
        contexts_array = contexts_map[:batch_size].copy()
    finally:
        del contexts_map
    horizon_steps = (
        max(RAW_HORIZONS_MINUTES) * 60 // artifact.manifest.cadence_seconds
    )
    decode_passes = (horizon_steps + 127) // 128
    uniforms_array = routing_uniforms(
        list(range(batch_size)),
        model_seed=artifact.manifest.model_seed,
        decode_passes=decode_passes,
        layers=inference.layers,
    )
    device = inference.runtime.name
    contexts = torch.as_tensor(contexts_array, device=device, dtype=torch.float32)
    uniforms = torch.as_tensor(uniforms_array, device=device, dtype=torch.float32)
    export_static_onnx(
        inference=inference,
        output_path=output_path,
        contexts=contexts,
        routing_uniforms=uniforms,
        cadence_seconds=artifact.manifest.cadence_seconds,
    )
    return {
        "schema_version": "fincast-tensorrt-static-onnx/v1",
        "onnx": str(output_path),
        "batch_size": batch_size,
        "cadence_seconds": artifact.manifest.cadence_seconds,
        "decode_passes": decode_passes,
        "layers": inference.layers,
        "input_manifest_sha256": artifact.manifest_sha256,
        "input_artifact_digest": artifact.artifact_digest,
        "provenance": inference.provenance,
    }
