from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import gc
import hashlib
import math
import time
from types import MethodType
from typing import Any, Iterator, Literal, Sequence

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from .fincast import (
    MODEL_REVISION,
    SOURCE_ARCHIVE_SHA256,
    SOURCE_FILE_SHA256,
    SOURCE_REVISION,
    FinCastAdapter,
)
from .precision_validation import sha256_file
from .raw_artifacts import RAW_HORIZONS_MINUTES, RAW_OUTPUT_COLUMNS

RawBackendName = Literal[
    "eager",
    "no_padding",
    "batched_experts",
    "cuda_graph",
    "tensorrt_fp32",
    "tensorrt_int8",
]

FP32_BACKENDS: tuple[RawBackendName, ...] = (
    "eager",
    "no_padding",
    "batched_experts",
    "cuda_graph",
    "tensorrt_fp32",
)
PYTORCH_FP32_BACKENDS = FP32_BACKENDS[:-1]
RAW_PATCH_LENGTH = 32
RAW_PATCH_TOKENS = 16
RAW_OUTPUT_PATCH_LENGTH = 128
RAW_TOP_N = 2
RAW_EXPERTS = 4
RAW_MIN_EXPERT_CAPACITY = 4


class RawInferenceError(RuntimeError):
    pass


def _stream_is_capturing(value: torch.Tensor) -> bool:
    return bool(
        value.is_cuda
        and torch.cuda.is_available()
        and torch.cuda.is_current_stream_capturing()
    )


@dataclass(frozen=True, slots=True)
class RawInferenceObservation:
    output: torch.Tensor
    graph_capture_ms: float | None = None
    graph_replay: bool = False
    tail_eager: bool = False


class RoutingCursor:
    """Sequential view over stateless [pass, layer, top_n, batch, token] values."""

    def __init__(self, uniforms: torch.Tensor, *, layers: int) -> None:
        if (
            uniforms.ndim != 5
            or uniforms.shape[1] != layers
            or uniforms.shape[2] != RAW_TOP_N
            or uniforms.shape[4] != RAW_PATCH_TOKENS
            or uniforms.dtype != torch.float32
        ):
            raise RawInferenceError("routing uniforms do not match the fixed FinCast decode shape")
        if not _stream_is_capturing(uniforms):
            if not bool(torch.isfinite(uniforms).all()) or not bool(
                ((uniforms > 0) & (uniforms < 1)).all()
            ):
                raise RawInferenceError(
                    "routing uniforms must be finite values strictly between zero and one"
                )
        self.uniforms = uniforms
        self.layers = layers
        self.index = 0

    @property
    def expected_calls(self) -> int:
        return int(self.uniforms.shape[0]) * self.layers

    def take(self, x: torch.Tensor) -> torch.Tensor:
        if self.index >= self.expected_calls:
            raise RawInferenceError("FinCast requested more routing values than the decode contract")
        decode_pass, layer = divmod(self.index, self.layers)
        self.index += 1
        values = self.uniforms[decode_pass, layer]
        if values.shape != (RAW_TOP_N, x.shape[0], x.shape[1]):
            raise RawInferenceError("routing uniform batch or token shape differs from the active layer")
        if values.device != x.device:
            raise RawInferenceError("routing uniforms and FinCast activations must share a device")
        return values


def _stateless_gate_forward(
    gate: Any,
    x: torch.Tensor,
    noise_gates: bool = False,
    noise_mult: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    if noise_gates or noise_mult != 1.0:
        raise RawInferenceError("raw FinCast routing does not permit graph-internal noise")
    cursor = getattr(gate, "_fincast_raw_routing_cursor", None)
    if not isinstance(cursor, RoutingCursor):
        raise RawInferenceError("raw FinCast routing values were not installed")
    if gate.training:
        raise RawInferenceError("raw FinCast routing requires evaluation mode")

    batch, group_size, _dim = x.shape
    top_n = int(gate.top_n)
    num_gates = int(gate.num_gates)
    if top_n != RAW_TOP_N or num_gates != RAW_EXPERTS or group_size != RAW_PATCH_TOKENS:
        raise RawInferenceError("FinCast router structure differs from the reviewed raw backend")
    capacity_factor = float(gate.capacity_factor_eval)
    expert_capacity = min(group_size, int(group_size * capacity_factor / num_gates))
    expert_capacity = max(expert_capacity, RAW_MIN_EXPERT_CAPACITY)

    gate_logits = gate.to_gates(x)
    raw_gates = gate_logits.softmax(dim=-1)
    topk_return = gate.topk(raw_gates, k=top_n)
    if gate.differentiable_topk:
        gates = topk_return.coor_descent_values
    else:
        gates = topk_return.values
    gate_indices = topk_return.indices
    gates = gates.permute(2, 0, 1)
    gate_indices = gate_indices.permute(2, 0, 1)
    one_hot_gate_indices = F.one_hot(gate_indices, num_classes=num_gates)
    mask = one_hot_gate_indices.float()

    eps = float(gate.eps)
    gates = gates / gates.sum(dim=0, keepdim=True).clamp(min=eps)
    threshold = gate.threshold_eval.clamp(min=eps).view(top_n, 1, 1)
    should_route = cursor.take(x) < (gates / threshold)
    should_route = torch.cat(
        (torch.ones_like(should_route[0:1], dtype=torch.bool), should_route[1:]),
        dim=0,
    )
    mask = mask * should_route.unsqueeze(-1).to(mask.dtype)
    mask_cumsum = torch.cumsum(mask, dim=-2) - mask

    routed_masks: list[torch.Tensor] = []
    positions: list[torch.Tensor] = []
    previous_expert_count: torch.Tensor | float = 0.0
    for route_index in range(top_n):
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
        num_classes=group_size * top_n + 1,
    )[..., :expert_capacity]
    combine_tensor = (
        weighted_gates.unsqueeze(-1).unsqueeze(-1)
        * mask_flat.unsqueeze(-1).unsqueeze(-1)
        * one_hot_gate_indices
        .to(weighted_gates.dtype)
        .unsqueeze(-1)
        * position_one_hot.to(weighted_gates.dtype).unsqueeze(-2)
    ).sum(dim=0)
    dispatch_tensor = combine_tensor.bool().to(x.dtype)
    if gate.straight_through_dispatch_tensor:
        dispatch_tensor = (
            dispatch_tensor + combine_tensor - combine_tensor.detach()
        )
    return dispatch_tensor, combine_tensor, gate.zero, gate.zero


def install_stateless_routing(model: Any) -> tuple[Any, ...]:
    gates = tuple(
        module for module in model.modules() if type(module).__name__ == "TopNGating"
    )
    layers = tuple(model.stacked_transformer.layers)
    if len(gates) != len(layers) or len(gates) <= 0:
        raise RawInferenceError("FinCast router count differs from its transformer layer count")
    for gate in gates:
        if int(gate.top_n) != RAW_TOP_N or int(gate.num_gates) != RAW_EXPERTS:
            raise RawInferenceError("FinCast router is not the reviewed top-2/four-expert shape")
        if not hasattr(gate, "_fincast_raw_original_forward"):
            gate._fincast_raw_original_forward = gate.forward
            gate.forward = MethodType(_stateless_gate_forward, gate)
    return gates


@contextmanager
def routing_scope(
    gates: Sequence[Any],
    uniforms: torch.Tensor,
) -> Iterator[None]:
    if any(getattr(gate, "_fincast_raw_routing_cursor", None) is not None for gate in gates):
        raise RawInferenceError("nested raw routing scopes are not supported")
    cursor = RoutingCursor(uniforms, layers=len(gates))
    for gate in gates:
        gate._fincast_raw_routing_cursor = cursor
    try:
        yield
        if cursor.index != cursor.expected_calls:
            raise RawInferenceError("FinCast consumed fewer routing values than the decode contract")
    finally:
        for gate in gates:
            gate._fincast_raw_routing_cursor = None


class PackedExperts(nn.Module):
    """Inference-only four-expert layer with two strided batched GEMMs."""

    def __init__(self, original: Any) -> None:
        super().__init__()
        experts = tuple(original.experts)
        if len(experts) != RAW_EXPERTS or bool(original.is_distributed):
            raise RawInferenceError("packed experts require one GPU and exactly four experts")
        dimensions = {
            (
                expert.gate_proj.in_features,
                expert.gate_proj.out_features,
                expert.down_proj.in_features,
                expert.down_proj.out_features,
                tuple(expert.layer_norm.normalized_shape),
                float(expert.layer_norm.eps),
            )
            for expert in experts
        }
        if len(dimensions) != 1:
            raise RawInferenceError("FinCast expert dimensions are not pack-compatible")
        dimension = int(experts[0].gate_proj.in_features)
        if dimensions != {(dimension, dimension, dimension, dimension, (dimension,), 1e-6)}:
            raise RawInferenceError("FinCast expert structure differs from the reviewed packed layout")

        tensors = {
            "gate_weight": torch.stack([item.gate_proj.weight.detach() for item in experts]),
            "gate_bias": torch.stack([item.gate_proj.bias.detach() for item in experts]),
            "down_weight": torch.stack([item.down_proj.weight.detach() for item in experts]),
            "down_bias": torch.stack([item.down_proj.bias.detach() for item in experts]),
            "norm_weight": torch.stack([item.layer_norm.weight.detach() for item in experts]),
            "norm_bias": torch.stack([item.layer_norm.bias.detach() for item in experts]),
        }
        for name, value in tensors.items():
            self.register_buffer(name, value.contiguous(), persistent=True)
        self.num_experts = RAW_EXPERTS
        self.dimension = dimension
        self.eps = 1e-6
        self.annotate_profiler = False
        self.original_value_digest = self._value_digest(tensors)
        if self.original_value_digest != self.packed_value_digest():
            raise RawInferenceError("packed FinCast expert values changed during construction")

    @staticmethod
    def _value_digest(values: dict[str, torch.Tensor]) -> str:
        digest = hashlib.sha256()
        for name in sorted(values):
            value = values[name].detach().cpu().contiguous()
            digest.update(name.encode("ascii"))
            digest.update(b"\0")
            digest.update(value.numpy().tobytes(order="C"))
        return digest.hexdigest()

    def packed_value_digest(self) -> str:
        return self._value_digest(
            {
                "gate_weight": self.gate_weight,
                "gate_bias": self.gate_bias,
                "down_weight": self.down_weight,
                "down_bias": self.down_bias,
                "norm_weight": self.norm_weight,
                "norm_bias": self.norm_bias,
            }
        )

    def forward(
        self,
        x: torch.Tensor,
        paddings: torch.Tensor | None = None,
        is_distributed: bool | None = None,
    ) -> torch.Tensor:
        if is_distributed:
            raise RawInferenceError("packed FinCast experts do not support distributed execution")
        if x.ndim != 4 or x.shape[1] != RAW_EXPERTS or x.shape[-1] != self.dimension:
            raise RawInferenceError("packed FinCast expert input shape is invalid")
        expert_input = x.permute(1, 0, 2, 3).contiguous()
        normalized = F.layer_norm(
            expert_input,
            (self.dimension,),
            weight=None,
            bias=None,
            eps=self.eps,
        )
        normalized = (
            normalized * self.norm_weight[:, None, None, :]
            + self.norm_bias[:, None, None, :]
        )
        flattened = normalized.flatten(1, 2)
        if self.annotate_profiler:
            with torch.autograd.profiler.record_function(
                "fincast_raw::packed_expert_gate_bmm"
            ):
                gate = torch.bmm(flattened, self.gate_weight.transpose(1, 2))
        else:
            gate = torch.bmm(flattened, self.gate_weight.transpose(1, 2))
        gate = F.relu(gate + self.gate_bias[:, None, :])
        if self.annotate_profiler:
            with torch.autograd.profiler.record_function(
                "fincast_raw::packed_expert_down_bmm"
            ):
                output = torch.bmm(gate, self.down_weight.transpose(1, 2))
        else:
            output = torch.bmm(gate, self.down_weight.transpose(1, 2))
        output = output + self.down_bias[:, None, :]
        output = output.view_as(expert_input)
        if paddings is not None:
            if paddings.shape != x.shape[:3]:
                raise RawInferenceError("packed FinCast expert padding shape is invalid")
            output = output * (
                1.0 - paddings.permute(1, 0, 2).unsqueeze(-1)
            )
        output = output + expert_input
        return output.permute(1, 0, 2, 3).contiguous()


def pack_model_experts(model: Any) -> tuple[PackedExperts, ...]:
    packed: list[PackedExperts] = []
    for layer in model.stacked_transformer.layers:
        inner_moe = layer.moe.moe
        if isinstance(inner_moe.experts, PackedExperts):
            packed.append(inner_moe.experts)
            continue
        replacement = PackedExperts(inner_moe.experts)
        inner_moe.experts = replacement
        packed.append(replacement)
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if len(packed) != len(model.stacked_transformer.layers):
        raise RawInferenceError("not every FinCast layer received packed expert weights")
    return tuple(packed)


def native_prediction_tensor(values: torch.Tensor) -> torch.Tensor:
    if values.ndim != 3 or values.shape[1:] != (4, RAW_OUTPUT_COLUMNS):
        raise RawInferenceError("FinCast raw output must have shape [batch,4,10]")
    promoted = values.float()
    quantiles = torch.sort(promoted[..., 1:], dim=-1).values
    output = torch.cat((promoted[..., 0:1], quantiles), dim=-1)
    if not _stream_is_capturing(output) and not bool(torch.isfinite(output).all()):
        raise RawInferenceError("FinCast raw output contains non-finite values")
    return output


class FinCastRawInference:
    def __init__(
        self,
        adapter: FinCastAdapter,
        *,
        backend: RawBackendName,
        graph_batch_size: int | None = None,
    ) -> None:
        if backend not in PYTORCH_FP32_BACKENDS:
            raise RawInferenceError(f"raw backend is unavailable in the FP32 runtime: {backend}")
        if adapter._precision != "float32":
            raise RawInferenceError("P40 raw generation is restricted to the qualified FP32 artifact")
        if graph_batch_size is not None and graph_batch_size <= 0:
            raise RawInferenceError("CUDA Graph batch size must be positive")
        if backend == "cuda_graph" and graph_batch_size is None:
            raise RawInferenceError("CUDA Graph requires one selected static batch size")

        self.adapter = adapter
        self.model = adapter._model
        self.runtime = adapter._runtime
        self.torch = self.runtime.torch
        self.backend = backend
        self.graph_batch_size = graph_batch_size
        self.gates = install_stateless_routing(self.model)
        self.layers = len(self.gates)
        self.packed_experts: tuple[PackedExperts, ...] = ()
        if backend in {"batched_experts", "cuda_graph"}:
            self.packed_experts = pack_model_experts(self.model)
        self._causal_masks: dict[tuple[torch.device, torch.dtype], torch.Tensor] = {}
        self._frequencies: dict[int, torch.Tensor] = {}
        self._paddings: dict[tuple[int, int], torch.Tensor] = {}
        self._graphs: dict[int, CudaGraphRunner] = {}

    @property
    def provenance(self) -> dict[str, Any]:
        artifact_path = getattr(self.adapter, "_artifact_path", None)
        if not isinstance(artifact_path, type(None)) and artifact_path is not None:
            weights_sha256 = sha256_file(artifact_path)
            weights_file = artifact_path.name
        else:
            weights_sha256 = "unavailable"
            weights_file = "unavailable"
        return {
            "model_id": self.adapter.provenance.model_id,
            "model_revision": MODEL_REVISION,
            "source_revision": SOURCE_REVISION,
            "source_archive_sha256": SOURCE_ARCHIVE_SHA256,
            "source_file_sha256": dict(sorted(SOURCE_FILE_SHA256.items())),
            "weights_file": weights_file,
            "weights_sha256": weights_sha256,
            "precision": self.adapter._precision,
            "device": self.runtime.name,
            "device_name": self.runtime.device_name,
            "cuda_capability": self.runtime.cuda_capability,
            "backend": self.backend,
            "packed_expert_layers": len(self.packed_experts),
            "routing_policy": "fincast-row-routing-uniform/v1",
        }

    def _frequency(self, batch_size: int) -> torch.Tensor:
        cached = self._frequencies.get(batch_size)
        if cached is None:
            cached = self.torch.zeros(
                (batch_size, 1),
                dtype=self.torch.long,
                device=self.runtime.name,
            )
            self._frequencies[batch_size] = cached
        return cached

    def _padding(self, batch_size: int, horizon_steps: int) -> torch.Tensor:
        key = (batch_size, horizon_steps)
        cached = self._paddings.get(key)
        if cached is None:
            cached = self.torch.zeros(
                (batch_size, 512 + horizon_steps),
                dtype=self.torch.float32,
                device=self.runtime.name,
            )
            self._paddings[key] = cached
        return cached

    def _causal_mask(self, hidden_states: torch.Tensor) -> torch.Tensor:
        key = (hidden_states.device, hidden_states.dtype)
        cached = self._causal_masks.get(key)
        if cached is None:
            row = self.torch.arange(RAW_PATCH_TOKENS, device=hidden_states.device).view(-1, 1)
            column = self.torch.arange(RAW_PATCH_TOKENS, device=hidden_states.device).view(1, -1)
            large_negative = -0.7 * self.torch.finfo(hidden_states.dtype).max
            cached = (
                (row < column).to(hidden_states.dtype)
                * large_negative
            ).view(1, 1, RAW_PATCH_TOKENS, RAW_PATCH_TOKENS)
            self._causal_masks[key] = cached
        return cached

    @staticmethod
    def _horizon_steps(cadence_seconds: int) -> int:
        if cadence_seconds not in (15, 30, 60):
            raise RawInferenceError("FinCast raw cadence must be 15, 30, or 60 seconds")
        return max(RAW_HORIZONS_MINUTES) * 60 // cadence_seconds

    @staticmethod
    def _horizon_indices(cadence_seconds: int) -> tuple[int, ...]:
        return tuple(
            horizon * 60 // cadence_seconds - 1
            for horizon in RAW_HORIZONS_MINUTES
        )

    def _validate_inputs(
        self,
        contexts: torch.Tensor,
        uniforms: torch.Tensor,
        cadence_seconds: int,
    ) -> int:
        if (
            contexts.ndim != 2
            or contexts.shape[1] != 512
            or contexts.dtype != self.torch.float32
            or contexts.device.type != "cuda"
        ):
            raise RawInferenceError("raw FinCast contexts must be CUDA FP32 [batch,512]")
        if not _stream_is_capturing(contexts):
            if not bool(self.torch.isfinite(contexts).all()) or not bool((contexts > 0).all()):
                raise RawInferenceError("raw FinCast contexts must contain finite positive closes")
            if bool((self.torch.abs(contexts - float(self.model.config.pad_val)) < 1e-6).any()):
                raise RawInferenceError(
                    "raw FinCast contexts must not contain the upstream padding sentinel"
                )
        horizon_steps = self._horizon_steps(cadence_seconds)
        decode_passes = math.ceil(horizon_steps / RAW_OUTPUT_PATCH_LENGTH)
        expected = (
            decode_passes,
            self.layers,
            RAW_TOP_N,
            contexts.shape[0],
            RAW_PATCH_TOKENS,
        )
        if tuple(uniforms.shape) != expected:
            raise RawInferenceError(f"routing uniform shape differs from {expected}")
        return horizon_steps

    def _predict_eager_core(
        self,
        contexts: torch.Tensor,
        uniforms: torch.Tensor,
        cadence_seconds: int,
    ) -> torch.Tensor:
        horizon_steps = self._validate_inputs(contexts, uniforms, cadence_seconds)
        with routing_scope(self.gates, uniforms):
            _mean, full = self.model.decode(
                input_ts=contexts,
                paddings=self._padding(contexts.shape[0], horizon_steps),
                freq=self._frequency(contexts.shape[0]),
                horizon_len=horizon_steps,
                output_patch_len=RAW_OUTPUT_PATCH_LENGTH,
                max_len=512,
                return_forecast_on_context=False,
            )
        indices = self.torch.tensor(
            self._horizon_indices(cadence_seconds),
            dtype=self.torch.long,
            device=contexts.device,
        )
        return native_prediction_tensor(full.index_select(1, indices))

    def _preprocess_no_padding(
        self,
        input_ts: torch.Tensor,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        batch_size = input_ts.shape[0]
        patched = input_ts.view(batch_size, RAW_PATCH_TOKENS, RAW_PATCH_LENGTH)
        first_patch = patched[:, 0, :]
        mu = first_patch.sum(dim=1) / float(RAW_PATCH_LENGTH)
        centered = first_patch - mu[:, None]
        sigma = self.torch.sqrt(
            (centered**2).sum(dim=1) / float(RAW_PATCH_LENGTH)
        ).clamp(min=float(self.model.config.tolerance))
        normalized = (patched - mu[:, None, None]) / sigma[:, None, None]

        projection = self.model.input_ff_layer
        hidden_linear = projection.hidden_layer[0]
        hidden = F.linear(
            normalized,
            hidden_linear.weight[:, :RAW_PATCH_LENGTH],
            hidden_linear.bias,
        )
        hidden = F.silu(hidden)
        output = F.linear(
            hidden,
            projection.output_layer.weight,
            projection.output_layer.bias,
        )
        residual = F.linear(
            normalized,
            projection.residual_layer.weight[:, :RAW_PATCH_LENGTH],
            projection.residual_layer.bias,
        )
        return output + residual, (mu, sigma)

    def _forward_no_padding(self, input_ts: torch.Tensor) -> torch.Tensor:
        model_input, stats = self._preprocess_no_padding(input_ts)
        model_input = model_input + self.model.freq_emb(
            self._frequency(input_ts.shape[0])
        )
        mask = self._causal_mask(model_input)
        hidden_states = model_input
        for layer in self.model.stacked_transformer.layers:
            residual = hidden_states
            normalized = layer.input_layernorm(hidden_states)
            _scores, attention = layer.self_attn(
                hidden_states=normalized,
                mask=mask,
            )
            hidden_states = residual + attention
            hidden_states, _total_aux, _balance, _router = layer.moe(
                hidden_states,
                paddings=None,
            )

        output = self.model.horizon_ff_layer(hidden_states)
        output = output.view(
            input_ts.shape[0],
            RAW_PATCH_TOKENS,
            RAW_OUTPUT_PATCH_LENGTH,
            RAW_OUTPUT_COLUMNS,
        )
        mu, sigma = stats
        return output * sigma[:, None, None, None] + mu[:, None, None, None]

    def _predict_no_padding_core(
        self,
        contexts: torch.Tensor,
        uniforms: torch.Tensor,
        cadence_seconds: int,
    ) -> torch.Tensor:
        horizon_steps = self._validate_inputs(contexts, uniforms, cadence_seconds)
        requested = self._horizon_indices(cadence_seconds)
        gathered: dict[int, torch.Tensor] = {}
        final_out = contexts
        decode_passes = math.ceil(horizon_steps / RAW_OUTPUT_PATCH_LENGTH)
        with routing_scope(self.gates, uniforms):
            for decode_pass in range(decode_passes):
                output = self._forward_no_padding(final_out[:, -512:])
                patch = output[:, -1, :, :]
                start = decode_pass * RAW_OUTPUT_PATCH_LENGTH
                end = start + RAW_OUTPUT_PATCH_LENGTH
                for requested_index in requested:
                    if start <= requested_index < end:
                        gathered[requested_index] = patch[:, requested_index - start, :]
                if decode_pass + 1 < decode_passes:
                    final_out = self.torch.cat(
                        (final_out, patch[:, :, 0]),
                        dim=-1,
                    )
        if tuple(sorted(gathered)) != tuple(sorted(requested)):
            raise RawInferenceError("no-padding decode did not gather every raw horizon")
        return native_prediction_tensor(
            self.torch.stack([gathered[index] for index in requested], dim=1)
        )

    def predict_tensor(
        self,
        contexts: torch.Tensor,
        uniforms: torch.Tensor,
        *,
        cadence_seconds: int,
    ) -> RawInferenceObservation:
        with self.torch.inference_mode():
            if self.backend == "eager":
                return RawInferenceObservation(
                    self._predict_eager_core(contexts, uniforms, cadence_seconds)
                )
            if self.backend in {"no_padding", "batched_experts"}:
                return RawInferenceObservation(
                    self._predict_no_padding_core(contexts, uniforms, cadence_seconds)
                )
            if self.backend == "cuda_graph":
                if contexts.shape[0] != self.graph_batch_size:
                    return RawInferenceObservation(
                        self._predict_no_padding_core(contexts, uniforms, cadence_seconds),
                        tail_eager=True,
                    )
                runner = self._graphs.get(cadence_seconds)
                if runner is None:
                    runner = CudaGraphRunner(
                        self,
                        contexts,
                        uniforms,
                        cadence_seconds=cadence_seconds,
                    )
                    self._graphs[cadence_seconds] = runner
                return runner.replay(contexts, uniforms)
        raise RawInferenceError(f"unhandled raw backend: {self.backend}")


class CudaGraphRunner:
    def __init__(
        self,
        backend: FinCastRawInference,
        initial_contexts: torch.Tensor,
        initial_uniforms: torch.Tensor,
        *,
        cadence_seconds: int,
    ) -> None:
        if not backend.torch.cuda.is_available():
            raise RawInferenceError("CUDA Graph is unavailable without CUDA")
        self.backend = backend
        self.cadence_seconds = cadence_seconds
        self.static_contexts = initial_contexts.clone()
        self.static_uniforms = initial_uniforms.clone()
        capture_stream = backend.torch.cuda.Stream()
        capture_stream.wait_stream(backend.torch.cuda.current_stream())
        with backend.torch.cuda.stream(capture_stream):
            for _ in range(3):
                backend._predict_no_padding_core(
                    self.static_contexts,
                    self.static_uniforms,
                    cadence_seconds,
                )
        backend.torch.cuda.current_stream().wait_stream(capture_stream)
        backend.torch.cuda.synchronize()

        self.graph = backend.torch.cuda.CUDAGraph()
        started = time.perf_counter()
        with backend.torch.cuda.graph(self.graph, stream=capture_stream):
            self.static_output = backend._predict_no_padding_core(
                self.static_contexts,
                self.static_uniforms,
                cadence_seconds,
            )
        backend.torch.cuda.synchronize()
        self.capture_ms = (time.perf_counter() - started) * 1_000

    def replay(
        self,
        contexts: torch.Tensor,
        uniforms: torch.Tensor,
    ) -> RawInferenceObservation:
        self.static_contexts.copy_(contexts)
        self.static_uniforms.copy_(uniforms)
        self.graph.replay()
        return RawInferenceObservation(
            self.static_output.clone(),
            graph_capture_ms=self.capture_ms,
            graph_replay=True,
        )


def numpy_output_digest(values: np.ndarray) -> str:
    bounded = np.ascontiguousarray(values, dtype="<f4")
    return hashlib.sha256(bounded.tobytes(order="C")).hexdigest()


def native_to_projected_compatibility(values: np.ndarray) -> np.ndarray:
    """Project native q10..q90 into the existing seven-quantile compatibility view."""

    bounded = np.asarray(values, dtype=np.float32)
    if bounded.ndim != 3 or bounded.shape[1:] != (4, RAW_OUTPUT_COLUMNS):
        raise RawInferenceError("native compatibility input must be [batch,4,10]")
    # The live adapter converts FP32 tensor values to Python floats before it
    # applies the two midpoint projections. Reproduce that compatibility view
    # in float64, then cast once to FP32 for an exact byte-level comparison.
    native = np.sort(bounded[..., 1:], axis=-1).astype(np.float64)
    projected = np.stack(
        (
            native[..., 0],
            native[..., 0],
            (native[..., 1] + native[..., 2]) / 2.0,
            native[..., 4],
            (native[..., 6] + native[..., 7]) / 2.0,
            native[..., 8],
            native[..., 8],
        ),
        axis=-1,
    )
    return np.ascontiguousarray(projected, dtype="<f4")
