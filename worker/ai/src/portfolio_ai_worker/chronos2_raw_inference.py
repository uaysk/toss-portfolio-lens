from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import time
from types import MethodType
from typing import Any, Literal, Sequence

import numpy as np
import torch

from .adapters import math_sdpa
from .chronos2 import (
    CHRONOS2_CONTEXT_WINDOWS,
    CHRONOS2_MAX_DIRECT_PREDICTION_STEPS,
    CHRONOS2_NATIVE_QUANTILES,
    CHRONOS2_OUTPUT_PATCH_SIZE,
    CHRONOS2_PADDED_PREDICTION_STEPS,
    CHRONOS2_PREDICTION_STEPS,
    Chronos2Adapter,
    chronos2_weights_path,
)

Chronos2RawBackend = Literal[
    "pipeline_eager",
    "worker_local",
    "no_padding",
    "gpu_gather",
    "cuda_graph",
]
CHRONOS2_RAW_BACKENDS: tuple[Chronos2RawBackend, ...] = (
    "pipeline_eager",
    "worker_local",
    "no_padding",
    "gpu_gather",
    "cuda_graph",
)
CHRONOS2_RAW_HORIZONS = (5, 15, 30, 60)
CHRONOS2_RAW_OUTPUT_COLUMNS = 1 + len(CHRONOS2_NATIVE_QUANTILES)
CHRONOS2_RAW_OUTPUT_SCHEMA = "chronos2-raw-predictions/v1"
CHRONOS2_RAW_POINT_POLICY = "native_q50_as_point_forecast_v1"
CHRONOS2_RAW_MONOTONE_POLICY = "fp32_sort_native_quantiles_per_horizon_v1"


class Chronos2RawInferenceError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Chronos2RawObservation:
    output: np.ndarray
    compute_cuda_ms: float | None
    graph_capture_ms: float | None = None
    graph_replay: bool = False
    tail_eager: bool = False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def _validate_arrays(
    contexts: np.ndarray,
    context_mask: np.ndarray,
    future: np.ndarray,
    future_mask: np.ndarray,
    *,
    padded_prediction_steps: int = CHRONOS2_PADDED_PREDICTION_STEPS,
) -> tuple[int, int]:
    if contexts.ndim != 3 or contexts.shape[2] not in CHRONOS2_CONTEXT_WINDOWS:
        raise Chronos2RawInferenceError("Chronos-2 contexts must have shape [tasks,variates,512|1024|2048|4096|8192]")
    tasks, variates, _context = contexts.shape
    if tasks < 1 or variates < 1:
        raise Chronos2RawInferenceError("Chronos-2 raw batches must contain at least one task and variate")
    if context_mask.shape != contexts.shape:
        raise Chronos2RawInferenceError("Chronos-2 context mask shape differs from contexts")
    expected_future = (tasks, variates, padded_prediction_steps)
    if future.shape != expected_future or future_mask.shape != expected_future:
        raise Chronos2RawInferenceError(
            f"Chronos-2 future buffers must have shape [tasks,variates,{padded_prediction_steps}]"
        )
    if contexts.dtype != np.float32 or future.dtype != np.float32:
        raise Chronos2RawInferenceError("Chronos-2 raw values must be native FP32 arrays")
    if context_mask.dtype != np.uint8 or future_mask.dtype != np.uint8:
        raise Chronos2RawInferenceError("Chronos-2 raw masks must be uint8 arrays")
    if not np.isfinite(contexts).all() or not np.isfinite(future).all():
        raise Chronos2RawInferenceError("Chronos-2 raw buffers must encode missing values only through masks")
    if np.any((context_mask != 0) & (context_mask != 1)) or np.any((future_mask != 0) & (future_mask != 1)):
        raise Chronos2RawInferenceError("Chronos-2 raw masks must be binary")
    if np.any(context_mask[:, 0] != 1):
        raise Chronos2RawInferenceError("Chronos-2 target context cannot contain missing values")
    if np.any(future_mask[:, 0] != 0):
        raise Chronos2RawInferenceError("Chronos-2 target values cannot be known in the forecast horizon")
    return tasks, variates


def _project_cpu(
    predictions: np.ndarray,
    *,
    horizon_steps: Sequence[int] = CHRONOS2_RAW_HORIZONS,
    prediction_steps: int = CHRONOS2_PREDICTION_STEPS,
) -> np.ndarray:
    if (
        predictions.ndim != 3
        or predictions.shape[1] != len(CHRONOS2_NATIVE_QUANTILES)
        or predictions.shape[2] < prediction_steps
    ):
        raise Chronos2RawInferenceError("Chronos-2 model output has an unexpected shape")
    monotone = np.sort(
        np.asarray(predictions, dtype=np.float32),
        axis=1,
    )
    selected = monotone[:, :, np.asarray(horizon_steps) - 1]
    selected = np.transpose(selected, (0, 2, 1))
    median_index = CHRONOS2_NATIVE_QUANTILES.index(0.5)
    return np.ascontiguousarray(
        np.concatenate(
            (selected[:, :, median_index : median_index + 1], selected),
            axis=-1,
        ),
        dtype=np.float32,
    )


def _project_gpu(
    predictions: torch.Tensor,
    horizon_indices: torch.Tensor,
) -> torch.Tensor:
    monotone = torch.sort(predictions.to(dtype=torch.float32), dim=1).values
    selected = torch.index_select(monotone, dim=2, index=horizon_indices)
    selected = selected.permute(0, 2, 1).contiguous()
    median_index = CHRONOS2_NATIVE_QUANTILES.index(0.5)
    return torch.cat(
        (selected[:, :, median_index : median_index + 1], selected),
        dim=-1,
    )


def _graph_safe_prepare_patched_future(
    model: object,
    future_covariates: torch.Tensor | None,
    future_covariates_mask: torch.Tensor | None,
    loc_scale: tuple[torch.Tensor, torch.Tensor],
    num_output_patches: int,
    batch_size: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Chronos-2's fixed-shape future preparation without a D2H boolean check.

    Upstream validates ``torch.isnan(...).any()`` inside ``forward``. Converting
    that CUDA tensor to a Python bool is illegal during graph capture. The raw
    artifact boundary already rejects non-finite values and validates the
    explicit mask, so the check can be removed for this fixed 64-step path
    without weakening the input contract.
    """

    chronos_config = model.chronos_config
    output_patch_size = int(chronos_config.output_patch_size)
    expected_steps = num_output_patches * output_patch_size
    if future_covariates is None or future_covariates_mask is None:
        raise Chronos2RawInferenceError("CUDA Graph requires explicit fixed-shape future values and masks")
    if (
        future_covariates.shape != (batch_size, expected_steps)
        or future_covariates_mask.shape != future_covariates.shape
    ):
        raise Chronos2RawInferenceError("CUDA Graph future values must exactly fill output patches")
    normalized, _ = model.instance_norm(future_covariates, loc_scale)
    normalized = normalized.to(model.dtype)
    normalized = torch.where(future_covariates_mask > 0, normalized, 0.0)
    patched_future_covariates = normalized.reshape(
        batch_size,
        num_output_patches,
        output_patch_size,
    )
    patched_future_covariates_mask = future_covariates_mask.reshape(
        batch_size,
        num_output_patches,
        output_patch_size,
    )
    final_future_length = expected_steps
    future_time_enc = (
        torch.arange(
            start=0,
            end=final_future_length,
            device=model.device,
            dtype=torch.float32,
        )
        .reshape(1, num_output_patches, output_patch_size)
        .expand(batch_size, -1, -1)
        .div(int(chronos_config.time_encoding_scale))
        .to(model.dtype)
    )
    return (
        torch.cat(
            [
                future_time_enc,
                patched_future_covariates,
                patched_future_covariates_mask,
            ],
            dim=-1,
        ),
        patched_future_covariates_mask,
    )


class _CudaGraph:
    def __init__(
        self,
        inference: Chronos2RawInference,
        *,
        task_batch_size: int,
        variates: int,
        context_bars: int,
    ) -> None:
        if inference.device.type != "cuda":
            raise Chronos2RawInferenceError("CUDA Graph requires a CUDA Chronos-2 runtime")
        inference._enable_graph_compatible_execution()
        self.task_batch_size = task_batch_size
        self.variates = variates
        self.contexts = torch.empty(
            (task_batch_size * variates, context_bars),
            dtype=torch.float32,
            device=inference.device,
        )
        self.context_mask = torch.empty_like(self.contexts, dtype=torch.uint8)
        self.future = torch.empty(
            (
                task_batch_size * variates,
                inference.padded_prediction_steps,
            ),
            dtype=torch.float32,
            device=inference.device,
        )
        self.future_mask = torch.empty_like(self.future, dtype=torch.uint8)
        self.group_ids = torch.arange(
            task_batch_size,
            dtype=torch.long,
            device=inference.device,
        ).repeat_interleave(variates)
        self.contexts.fill_(1.0)
        self.context_mask.fill_(1)
        self.future.zero_()
        self.future_mask.zero_()
        side_stream = torch.cuda.Stream(device=inference.device)
        side_stream.wait_stream(torch.cuda.current_stream(inference.device))
        try:
            with (
                torch.cuda.stream(side_stream),
                math_sdpa(inference.torch),
                torch.no_grad(),
            ):
                for _ in range(3):
                    # Capture only the model core. GPU projection previously
                    # constructed a CUDA index tensor from a Python list while
                    # capture was active, which is an illegal H2D operation.
                    self.output = inference._direct_forward(
                        self.contexts,
                        self.context_mask,
                        self.future,
                        self.future_mask,
                        self.group_ids,
                        gpu_project=False,
                    )
            torch.cuda.current_stream(inference.device).wait_stream(side_stream)
            torch.cuda.synchronize(inference.device)
        except Exception as error:
            raise Chronos2RawInferenceError(
                f"CUDA Graph warm-up failed before capture: {type(error).__name__}: {error}"
            ) from error
        self.graph = torch.cuda.CUDAGraph()
        capture_started = time.perf_counter()
        try:
            # Reuse the warmed side stream explicitly. The graph captures only
            # fixed-shape device operations; projection and D2H transfer happen
            # after replay and cannot poison the capture.
            with math_sdpa(inference.torch), torch.no_grad():
                with torch.cuda.graph(self.graph, stream=side_stream):
                    self.output = inference._direct_forward(
                        self.contexts,
                        self.context_mask,
                        self.future,
                        self.future_mask,
                        self.group_ids,
                        gpu_project=False,
                    )
            torch.cuda.synchronize(inference.device)
        except Exception as error:
            raise Chronos2RawInferenceError(
                f"CUDA Graph core capture failed: {type(error).__name__}: {error}"
            ) from error
        self.capture_ms = (time.perf_counter() - capture_started) * 1_000

    def replay(
        self,
        contexts: torch.Tensor,
        context_mask: torch.Tensor,
        future: torch.Tensor,
        future_mask: torch.Tensor,
    ) -> torch.Tensor:
        self.contexts.copy_(contexts)
        self.context_mask.copy_(context_mask)
        self.future.copy_(future)
        self.future_mask.copy_(future_mask)
        self.graph.replay()
        return self.output


class _PinnedStaging:
    """Reusable fixed-shape host/device transfer buffers for one active graph."""

    def __init__(
        self,
        torch: Any,
        device: Any,
        *,
        tasks: int,
        variates: int,
        context_bars: int,
        future_steps: int,
    ) -> None:
        self.key = (tasks, variates, context_bars, future_steps)
        flattened = tasks * variates
        self.host_contexts = torch.empty(
            (flattened, context_bars),
            dtype=torch.float32,
            pin_memory=True,
        )
        self.host_context_mask = torch.empty(
            (flattened, context_bars),
            dtype=torch.uint8,
            pin_memory=True,
        )
        self.host_future = torch.empty(
            (flattened, future_steps),
            dtype=torch.float32,
            pin_memory=True,
        )
        self.host_future_mask = torch.empty(
            (flattened, future_steps),
            dtype=torch.uint8,
            pin_memory=True,
        )
        self.device_contexts = torch.empty_like(
            self.host_contexts,
            device=device,
        )
        self.device_context_mask = torch.empty_like(
            self.host_context_mask,
            device=device,
        )
        self.device_future = torch.empty_like(
            self.host_future,
            device=device,
        )
        self.device_future_mask = torch.empty_like(
            self.host_future_mask,
            device=device,
        )
        self.group_ids = torch.arange(
            tasks,
            dtype=torch.long,
            device=device,
        ).repeat_interleave(variates)

    def load(
        self,
        contexts: np.ndarray,
        context_mask: np.ndarray,
        future: np.ndarray,
        future_mask: np.ndarray,
    ) -> tuple[Any, Any, Any, Any, Any]:
        np.copyto(
            self.host_contexts.numpy(),
            np.asarray(contexts, dtype=np.float32).reshape(
                self.host_contexts.shape
            ),
            casting="no",
        )
        np.copyto(
            self.host_context_mask.numpy(),
            np.asarray(context_mask, dtype=np.uint8).reshape(
                self.host_context_mask.shape
            ),
            casting="no",
        )
        np.copyto(
            self.host_future.numpy(),
            np.asarray(future, dtype=np.float32).reshape(self.host_future.shape),
            casting="no",
        )
        np.copyto(
            self.host_future_mask.numpy(),
            np.asarray(future_mask, dtype=np.uint8).reshape(
                self.host_future_mask.shape
            ),
            casting="no",
        )
        self.device_contexts.copy_(self.host_contexts, non_blocking=True)
        self.device_context_mask.copy_(
            self.host_context_mask,
            non_blocking=True,
        )
        self.device_future.copy_(self.host_future, non_blocking=True)
        self.device_future_mask.copy_(
            self.host_future_mask,
            non_blocking=True,
        )
        return (
            self.device_contexts,
            self.device_context_mask,
            self.device_future,
            self.device_future_mask,
            self.group_ids,
        )


class Chronos2RawInference:
    def __init__(
        self,
        adapter: Chronos2Adapter,
        *,
        backend: Chronos2RawBackend,
        variate_names: Sequence[str],
        graph_task_batch_size: int | None = None,
        prediction_steps: int = CHRONOS2_PREDICTION_STEPS,
        horizon_steps: Sequence[int] = CHRONOS2_RAW_HORIZONS,
    ) -> None:
        if backend not in CHRONOS2_RAW_BACKENDS:
            raise Chronos2RawInferenceError("unsupported Chronos-2 raw backend")
        if not variate_names or variate_names[0] != "target_close":
            raise Chronos2RawInferenceError("Chronos-2 target must be the first variate")
        self.adapter = adapter
        self.backend = backend
        self.variate_names = tuple(variate_names)
        self.pipeline = adapter.pipeline
        self.model = adapter.pipeline.model
        self.torch = adapter._runtime.torch
        self.device = self.model.device
        self.graph_task_batch_size = graph_task_batch_size
        if prediction_steps < 1 or prediction_steps > CHRONOS2_MAX_DIRECT_PREDICTION_STEPS:
            raise Chronos2RawInferenceError("Chronos-2 raw prediction length exceeds direct output capacity")
        normalized_horizons = tuple(int(value) for value in horizon_steps)
        if (
            not 1 <= len(normalized_horizons) <= len(CHRONOS2_RAW_HORIZONS)
            or any(value < 1 or value > prediction_steps for value in normalized_horizons)
            or tuple(sorted(normalized_horizons)) != normalized_horizons
        ):
            raise Chronos2RawInferenceError(
                "Chronos-2 raw horizon steps must contain one to four ordered in-range values"
            )
        self.prediction_steps = prediction_steps
        self.padded_prediction_steps = (
            math.ceil(prediction_steps / CHRONOS2_OUTPUT_PATCH_SIZE) * CHRONOS2_OUTPUT_PATCH_SIZE
        )
        self.horizon_steps = normalized_horizons
        self.horizon_indices = torch.tensor(
            [value - 1 for value in normalized_horizons],
            dtype=torch.long,
            device=self.device,
        )
        self._graph: _CudaGraph | None = None
        self._pinned_staging: _PinnedStaging | None = None
        self._start_event = (
            torch.cuda.Event(enable_timing=True)
            if self.device.type == "cuda"
            else None
        )
        self._end_event = (
            torch.cuda.Event(enable_timing=True)
            if self.device.type == "cuda"
            else None
        )
        self._original_prepare_patched_future: object | None = None
        if backend == "cuda_graph" and (graph_task_batch_size is None or graph_task_batch_size < 1):
            raise Chronos2RawInferenceError("CUDA Graph requires a positive fixed task batch size")

    def _enable_graph_compatible_execution(self) -> None:
        if not bool(
            getattr(
                self.model,
                "_portfolio_ai_worker_graph_safe_future_preparation",
                False,
            )
        ):
            original = getattr(self.model, "_prepare_patched_future", None)
            if not callable(original):
                raise Chronos2RawInferenceError("Chronos-2 model has no compatible future preparation method")
            self._original_prepare_patched_future = original
            self.model._prepare_patched_future = MethodType(
                _graph_safe_prepare_patched_future,
                self.model,
            )
            self.model._portfolio_ai_worker_graph_safe_future_preparation = True
        # Torch 2.6's Pascal SDPA math path is not CUDA-graph capturable. The
        # pinned Chronos-2 eager attention is the same scale=1 FP32 algorithm,
        # and an uncaptured execution under this exact configuration is used as
        # the byte-exact graph gate.
        configured = 0
        for module in self.model.modules():
            config = getattr(module, "config", None)
            if config is not None and hasattr(config, "_attn_implementation"):
                config._attn_implementation = "eager"
                configured += 1
        if configured == 0:
            raise Chronos2RawInferenceError("Chronos-2 attention implementation cannot be made graph-compatible")

    @property
    def provenance(self) -> dict[str, object]:
        weights_path = chronos2_weights_path(self.adapter._settings.model_cache_dir)
        return {
            "model_id": self.adapter.provenance.model_id,
            "model_revision": self.adapter.provenance.model_revision,
            "source_revision": self.adapter.provenance.source_revision,
            "loader_version": self.adapter.provenance.loader_version,
            "weights_sha256": _sha256(weights_path) if weights_path.is_file() else "unavailable",
            "backend": self.backend,
            "input_profile": self.adapter.input_profile,
            "variate_names": list(self.variate_names),
            "cross_learning": False,
            "prediction_steps": self.prediction_steps,
            "padded_prediction_steps": self.padded_prediction_steps,
            "horizon_steps": list(self.horizon_steps),
            "dtype": "float32",
            "attention_backend": "math",
            "cuda_graph_attention_implementation": (
                "eager_matmul_scale_1" if self.backend == "cuda_graph" else "not_applicable"
            ),
            "transfer_policy": (
                "reused_pinned_host_and_device_staging_v1"
                if self.device.type == "cuda"
                else "cpu_direct_v1"
            ),
            "point_forecast_policy": CHRONOS2_RAW_POINT_POLICY,
            "quantile_monotonicity_policy": CHRONOS2_RAW_MONOTONE_POLICY,
            "packed_experts": {
                "status": "not_applicable",
                "reason": "Chronos-2 uses dense feed-forward blocks and has no MoE experts.",
            },
            "tensorrt": {
                "status": "unavailable",
                "reason": (
                    "TensorRT artifacts were removed by operator decision; "
                    "no implicit rebuild or promotion is permitted."
                ),
            },
        }

    def _prepared_inputs(
        self,
        contexts: np.ndarray,
        context_mask: np.ndarray,
        future: np.ndarray,
        future_mask: np.ndarray,
    ) -> list[dict[str, object]]:
        tasks, variates = _validate_arrays(
            contexts,
            context_mask,
            future,
            future_mask,
            padded_prediction_steps=self.padded_prediction_steps,
        )
        n_future_covariates = int(np.count_nonzero(future_mask[0].any(axis=1)))
        if n_future_covariates and not np.all(
            future_mask[
                :,
                -n_future_covariates:,
                : self.prediction_steps,
            ]
            == 1
        ):
            raise Chronos2RawInferenceError("Chronos-2 known-future variates must be contiguous trailing rows")
        inputs: list[dict[str, object]] = []
        for task in range(tasks):
            context_tensor = torch.from_numpy(np.array(contexts[task], copy=True))
            context_tensor.masked_fill_(
                torch.from_numpy(np.array(context_mask[task], copy=True)) == 0,
                torch.nan,
            )
            future_tensor = torch.from_numpy(
                np.array(
                    future[task, :, : self.prediction_steps],
                    copy=True,
                )
            )
            future_tensor.masked_fill_(
                torch.from_numpy(
                    np.array(
                        future_mask[task, :, : self.prediction_steps],
                        copy=True,
                    )
                )
                == 0,
                torch.nan,
            )
            inputs.append(
                {
                    "context": context_tensor,
                    "future_covariates": future_tensor,
                    "n_targets": 1,
                    "n_covariates": variates - 1,
                    "n_future_covariates": n_future_covariates,
                }
            )
        return inputs

    def _pipeline_predict(
        self,
        contexts: np.ndarray,
        context_mask: np.ndarray,
        future: np.ndarray,
        future_mask: np.ndarray,
        *,
        variate_batch_size: int,
    ) -> Chronos2RawObservation:
        inputs = self._prepared_inputs(contexts, context_mask, future, future_mask)
        with math_sdpa(self.torch), self.torch.inference_mode():
            predictions = self.pipeline.predict(
                inputs,
                prediction_length=self.prediction_steps,
                batch_size=variate_batch_size,
                context_length=contexts.shape[2],
                cross_learning=False,
                limit_prediction_length=False,
                max_output_patches=(CHRONOS2_MAX_DIRECT_PREDICTION_STEPS // CHRONOS2_OUTPUT_PATCH_SIZE),
            )
        target = np.stack(
            [value[0].detach().to(dtype=self.torch.float32, device="cpu").numpy() for value in predictions],
            axis=0,
        )
        return Chronos2RawObservation(
            output=_project_cpu(
                target,
                horizon_steps=self.horizon_steps,
                prediction_steps=self.prediction_steps,
            ),
            compute_cuda_ms=None,
        )

    def _direct_forward(
        self,
        contexts: torch.Tensor,
        context_mask: torch.Tensor,
        future: torch.Tensor,
        future_mask: torch.Tensor,
        group_ids: torch.Tensor,
        *,
        gpu_project: bool,
    ) -> torch.Tensor:
        quantiles = self.model(
            context=contexts,
            context_mask=context_mask,
            group_ids=group_ids,
            future_covariates=future,
            future_covariates_mask=future_mask,
            num_output_patches=math.ceil(self.prediction_steps / self.model.chronos_config.output_patch_size),
        ).quantile_preds
        variates = len(self.variate_names)
        target_predictions = quantiles[::variates]
        return _project_gpu(target_predictions, self.horizon_indices) if gpu_project else target_predictions

    def _to_device(
        self,
        contexts: np.ndarray,
        context_mask: np.ndarray,
        future: np.ndarray,
        future_mask: np.ndarray,
        *,
        padded_future: bool,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        tasks, variates = _validate_arrays(
            contexts,
            context_mask,
            future,
            future_mask,
            padded_prediction_steps=self.padded_prediction_steps,
        )
        future_steps = self.padded_prediction_steps if padded_future else self.prediction_steps
        if self.device.type == "cuda":
            key = (
                tasks,
                variates,
                contexts.shape[2],
                future_steps,
            )
            if self._pinned_staging is None or self._pinned_staging.key != key:
                self._pinned_staging = _PinnedStaging(
                    self.torch,
                    self.device,
                    tasks=tasks,
                    variates=variates,
                    context_bars=contexts.shape[2],
                    future_steps=future_steps,
                )
            return self._pinned_staging.load(
                contexts,
                context_mask,
                future[:, :, :future_steps],
                future_mask[:, :, :future_steps],
            )

        def transfer(
            value: np.ndarray,
            dtype: torch.dtype,
        ) -> torch.Tensor:
            # Raw artifacts are read-only memmaps. Always materialize a
            # writable host buffer before sharing it with torch.
            host = torch.from_numpy(np.array(value, copy=True, order="C"))
            if self.device.type == "cuda":
                host = host.pin_memory()
                return host.to(
                    device=self.device,
                    dtype=dtype,
                    non_blocking=True,
                )
            return host.to(device=self.device, dtype=dtype)

        device_contexts = transfer(
            contexts.reshape(tasks * variates, -1),
            torch.float32,
        )
        device_context_mask = transfer(
            context_mask.reshape(tasks * variates, -1),
            torch.uint8,
        )
        device_future = transfer(
            future[:, :, :future_steps].reshape(tasks * variates, -1),
            torch.float32,
        )
        device_future_mask = transfer(
            future_mask[:, :, :future_steps].reshape(tasks * variates, -1),
            torch.uint8,
        )
        group_ids = torch.arange(
            tasks,
            dtype=torch.long,
            device=self.device,
        ).repeat_interleave(variates)
        return (
            device_contexts,
            device_context_mask,
            device_future,
            device_future_mask,
            group_ids,
        )

    def predict(
        self,
        contexts: np.ndarray,
        context_mask: np.ndarray,
        future: np.ndarray,
        future_mask: np.ndarray,
        *,
        variate_batch_size: int,
    ) -> Chronos2RawObservation:
        tasks, variates = _validate_arrays(
            contexts,
            context_mask,
            future,
            future_mask,
            padded_prediction_steps=self.padded_prediction_steps,
        )
        if variates != len(self.variate_names):
            raise Chronos2RawInferenceError("Chronos-2 artifact variates differ from the backend")
        if self.backend == "pipeline_eager":
            return self._pipeline_predict(
                contexts,
                context_mask,
                future,
                future_mask,
                variate_batch_size=variate_batch_size,
            )
        padded_future = self.backend in {"no_padding", "gpu_gather", "cuda_graph"}
        device_values = self._to_device(
            contexts,
            context_mask,
            future,
            future_mask,
            padded_future=padded_future,
        )
        device_contexts, device_context_mask, device_future, device_future_mask, group_ids = device_values
        if self.backend == "cuda_graph":
            if tasks != self.graph_task_batch_size:
                eager = Chronos2RawInference(
                    self.adapter,
                    backend="gpu_gather",
                    variate_names=self.variate_names,
                )
                observation = eager.predict(
                    contexts,
                    context_mask,
                    future,
                    future_mask,
                    variate_batch_size=variate_batch_size,
                )
                return Chronos2RawObservation(
                    output=observation.output,
                    compute_cuda_ms=observation.compute_cuda_ms,
                    tail_eager=True,
                )
            capture_ms: float | None = None
            if self._graph is None:
                self._graph = _CudaGraph(
                    self,
                    task_batch_size=tasks,
                    variates=variates,
                    context_bars=contexts.shape[2],
                )
                capture_ms = self._graph.capture_ms
            start = self._start_event
            end = self._end_event
            if start is None or end is None:
                raise Chronos2RawInferenceError(
                    "CUDA Graph timing events were not initialized"
                )
            start.record()
            raw_output = self._graph.replay(
                device_contexts,
                device_context_mask,
                device_future,
                device_future_mask,
            )
            output = _project_gpu(raw_output, self.horizon_indices)
            end.record()
            end.synchronize()
            return Chronos2RawObservation(
                output=np.ascontiguousarray(
                    output.detach().to(device="cpu", dtype=torch.float32).numpy(),
                    dtype=np.float32,
                ),
                compute_cuda_ms=float(start.elapsed_time(end)),
                graph_capture_ms=capture_ms,
                graph_replay=True,
            )

        gpu_project = self.backend == "gpu_gather"
        use_events = self.device.type == "cuda"
        start = self._start_event if use_events else None
        end = self._end_event if use_events else None
        context = math_sdpa(self.torch) if self.device.type == "cuda" else nullcontext()
        with context, self.torch.inference_mode():
            if start is not None:
                start.record()
            predictions = self._direct_forward(
                device_contexts,
                device_context_mask,
                device_future,
                device_future_mask,
                group_ids,
                gpu_project=gpu_project,
            )
            if end is not None:
                end.record()
        if end is not None:
            end.synchronize()
            compute_ms = float(start.elapsed_time(end)) if start is not None else None
        else:
            compute_ms = None
        if gpu_project:
            output = predictions.detach().to(device="cpu", dtype=torch.float32).numpy()
            values = np.ascontiguousarray(output, dtype=np.float32)
        else:
            full = predictions.detach().to(device="cpu", dtype=torch.float32).numpy()
            values = _project_cpu(
                full,
                horizon_steps=self.horizon_steps,
                prediction_steps=self.prediction_steps,
            )
        return Chronos2RawObservation(
            output=values,
            compute_cuda_ms=compute_ms,
        )


def chronos2_raw_output_digest(output: np.ndarray) -> str:
    values = np.ascontiguousarray(output, dtype="<f4")
    if (
        values.ndim != 3
        or values.shape[1:] != (len(CHRONOS2_RAW_HORIZONS), CHRONOS2_RAW_OUTPUT_COLUMNS)
        or not np.isfinite(values).all()
        or np.any(np.diff(values[:, :, 1:], axis=-1) < 0)
    ):
        raise Chronos2RawInferenceError("Chronos-2 raw output fails shape, finite, or monotonicity checks")
    return hashlib.sha256(values.tobytes(order="C")).hexdigest()
