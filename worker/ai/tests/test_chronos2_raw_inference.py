from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from portfolio_ai_worker.adapters import RuntimeDevice
from portfolio_ai_worker.chronos2 import CHRONOS2_NATIVE_QUANTILES
from portfolio_ai_worker.chronos2_raw_inference import (
    Chronos2RawInference,
    Chronos2RawInferenceError,
    _graph_safe_prepare_patched_future,
    _project_gpu,
    chronos2_raw_output_digest,
)


class _Model:
    device = torch.device("cpu")
    chronos_config = SimpleNamespace(output_patch_size=16)

    def __call__(self, **kwargs: object) -> SimpleNamespace:
        context = kwargs["context"]
        assert isinstance(context, torch.Tensor)
        quantiles = torch.arange(
            len(CHRONOS2_NATIVE_QUANTILES),
            dtype=torch.float32,
        ).flip(0)
        row = torch.arange(context.shape[0], dtype=torch.float32)
        output = (quantiles[None, :, None] + row[:, None, None] * 100).expand(-1, -1, 64)
        return SimpleNamespace(quantile_preds=output)


class _Pipeline:
    def __init__(self) -> None:
        self.model = _Model()

    def predict(self, inputs: object, **kwargs: object) -> list[torch.Tensor]:
        assert isinstance(inputs, list)
        variates = int(inputs[0]["context"].shape[0])
        values: list[torch.Tensor] = []
        for task in range(len(inputs)):
            quantiles = torch.arange(
                len(CHRONOS2_NATIVE_QUANTILES),
                dtype=torch.float32,
            ).flip(0)
            prediction = (quantiles[:, None] + task * variates * 100).expand(-1, 60)
            values.append(prediction.unsqueeze(0))
        assert kwargs["cross_learning"] is False
        return values


def _adapter() -> object:
    return SimpleNamespace(
        pipeline=_Pipeline(),
        _pipeline=_Pipeline(),
        _runtime=RuntimeDevice("cpu", torch),
    )


def _arrays(
    tasks: int = 3,
    variates: int = 2,
    context_bars: int = 512,
    future_steps: int = 64,
) -> tuple[np.ndarray, ...]:
    contexts = np.ones((tasks, variates, context_bars), dtype=np.float32)
    context_mask = np.ones_like(contexts, dtype=np.uint8)
    future = np.zeros((tasks, variates, future_steps), dtype=np.float32)
    future_mask = np.zeros_like(future, dtype=np.uint8)
    future_mask[:, -1] = 1
    return contexts, context_mask, future, future_mask


@pytest.mark.parametrize(
    "backend",
    ["pipeline_eager", "worker_local", "no_padding", "gpu_gather"],
)
def test_chronos2_raw_backends_preserve_same_fixed_projection(backend: str) -> None:
    inference = Chronos2RawInference(
        _adapter(),  # type: ignore[arg-type]
        backend=backend,  # type: ignore[arg-type]
        variate_names=("target_close", "minute_of_day_sin"),
    )
    observation = inference.predict(*_arrays(), variate_batch_size=16)

    assert observation.output.shape == (3, 4, 22)
    assert observation.output.dtype == np.float32
    assert np.all(np.diff(observation.output[:, :, 1:], axis=-1) >= 0)
    assert np.array_equal(observation.output[:, :, 0], observation.output[:, :, 11])
    assert chronos2_raw_output_digest(observation.output)


def test_chronos2_raw_backend_outputs_are_exactly_batch_invariant() -> None:
    inference = Chronos2RawInference(
        _adapter(),  # type: ignore[arg-type]
        backend="gpu_gather",
        variate_names=("target_close", "minute_of_day_sin"),
    )
    together = inference.predict(*_arrays(), variate_batch_size=16).output
    split = np.concatenate(
        [
            inference.predict(
                *(value[index : index + 1] for value in _arrays()),
                variate_batch_size=16,
            ).output
            for index in range(3)
        ],
        axis=0,
    )

    # The fake model deliberately uses flattened row ordinal, unlike real
    # cross_learning=False Chronos-2. Normalize that test-only offset before
    # asserting the projection itself is invariant.
    for index in range(3):
        split[index] += index * 200
    np.testing.assert_array_equal(together, split)


@pytest.mark.parametrize("context_bars", [512, 1024, 2048, 4096, 8192])
def test_chronos2_raw_backends_accept_each_qualified_context(
    context_bars: int,
) -> None:
    inference = Chronos2RawInference(
        _adapter(),  # type: ignore[arg-type]
        backend="gpu_gather",
        variate_names=("target_close", "minute_of_day_sin"),
    )
    output = inference.predict(
        *_arrays(context_bars=context_bars),
        variate_batch_size=16,
    ).output
    assert output.shape == (3, 4, 22)


def test_chronos2_cuda_graph_refuses_cpu_capture() -> None:
    inference = Chronos2RawInference(
        _adapter(),  # type: ignore[arg-type]
        backend="cuda_graph",
        variate_names=("target_close", "minute_of_day_sin"),
        graph_task_batch_size=3,
    )
    with pytest.raises(Chronos2RawInferenceError, match="CUDA"):
        inference.predict(*_arrays(), variate_batch_size=16)


def test_chronos2_direct_path_supports_realtime_two_horizon_projection() -> None:
    inference = Chronos2RawInference(
        _adapter(),  # type: ignore[arg-type]
        backend="gpu_gather",
        variate_names=("target_close", "minute_of_day_sin"),
        prediction_steps=15,
        horizon_steps=(5, 15),
    )

    output = inference.predict(
        *_arrays(future_steps=16),
        variate_batch_size=16,
    ).output

    assert output.shape == (3, 2, 1 + len(CHRONOS2_NATIVE_QUANTILES))


def test_graph_safe_future_preparation_matches_upstream_fixed_shape() -> None:
    from chronos.chronos2.model import Chronos2Model

    class InstanceNorm:
        def __call__(
            self,
            value: torch.Tensor,
            loc_scale: tuple[torch.Tensor, torch.Tensor],
        ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
            loc, scale = loc_scale
            return (value - loc) / scale, loc_scale

    model = SimpleNamespace(
        chronos_config=SimpleNamespace(
            output_patch_size=16,
            time_encoding_scale=8192,
        ),
        instance_norm=InstanceNorm(),
        dtype=torch.float32,
        device=torch.device("cpu"),
    )
    future = torch.arange(2 * 64, dtype=torch.float32).reshape(2, 64)
    mask = torch.zeros_like(future, dtype=torch.uint8)
    mask[:, 32:] = 1
    loc_scale = (
        torch.tensor([[3.0], [7.0]]),
        torch.tensor([[2.0], [4.0]]),
    )

    expected = Chronos2Model._prepare_patched_future(
        model,  # type: ignore[arg-type]
        future,
        mask,
        loc_scale,
        4,
        2,
    )
    actual = _graph_safe_prepare_patched_future(
        model,
        future,
        mask,
        loc_scale,
        4,
        2,
    )

    torch.testing.assert_close(actual[0], expected[0], rtol=0, atol=0)
    torch.testing.assert_close(actual[1], expected[1], rtol=0, atol=0)


def test_gpu_projection_uses_preallocated_indices() -> None:
    predictions = torch.arange(
        2 * len(CHRONOS2_NATIVE_QUANTILES) * 720,
        dtype=torch.float32,
    ).reshape(2, len(CHRONOS2_NATIVE_QUANTILES), 720)
    indices = torch.tensor([59, 179, 359, 719], dtype=torch.long)

    projected = _project_gpu(predictions, indices)

    assert projected.shape == (2, 4, 1 + len(CHRONOS2_NATIVE_QUANTILES))
    assert torch.equal(projected[:, :, 0], projected[:, :, 11])
