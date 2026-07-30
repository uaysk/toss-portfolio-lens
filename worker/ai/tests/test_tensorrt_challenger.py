from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn

from portfolio_ai_worker.raw_inference import RoutingCursor, _stateless_gate_forward
from portfolio_ai_worker.tensorrt_challenger import (
    CALIBRATION_ROWS,
    FROZEN_CONTEXT_ROWS,
    HOLDOUT_ROWS,
    calibration_split,
    probe_tensorrt_environment,
    top2_route_reference,
    write_unavailable_challenger_artifact,
)
from portfolio_ai_worker.tensorrt_export import _TensorRTRoute


def test_calibration_split_is_digest_based_disjoint_complete_and_stable() -> None:
    contexts = (
        np.arange(FROZEN_CONTEXT_ROWS * 512, dtype=np.float32)
        .reshape(FROZEN_CONTEXT_ROWS, 512)
        + np.float32(1)
    )
    first = calibration_split(contexts)
    second = calibration_split(contexts.copy())

    assert first == second
    assert len(first.calibration_indices) == CALIBRATION_ROWS
    assert len(first.holdout_indices) == HOLDOUT_ROWS
    assert not set(first.calibration_indices) & set(first.holdout_indices)
    assert sorted((*first.calibration_indices, *first.holdout_indices)) == list(
        range(FROZEN_CONTEXT_ROWS)
    )
    assert len(first.split_digest) == 64


def test_unavailable_probe_and_artifact_never_claim_engine_or_accuracy(
    tmp_path: Path,
) -> None:
    plugin_source = tmp_path / "missing.cu"
    environment = probe_tensorrt_environment(plugin_source=plugin_source)
    assert environment["status"] == "unavailable"
    assert "routing_plugin_source_unavailable" in environment["reasons"]

    contexts = np.full((FROZEN_CONTEXT_ROWS, 512), 100, dtype=np.float32)
    output = (tmp_path / "challenger.json").resolve()
    artifact = write_unavailable_challenger_artifact(
        output,
        environment=environment,
        split=calibration_split(contexts),
        model_provenance={"weights_sha256": "a" * 64},
    )
    assert artifact["status"] == "unavailable"
    assert artifact["engine"] is None
    assert artifact["accuracy_gate"] is None
    assert artifact["latency"] is None
    assert output.is_file()


def test_routing_plugin_is_fixed_sm61_fp32_and_uses_explicit_uniform_input() -> None:
    root = Path(__file__).resolve().parents[1] / "tensorrt"
    source = (root / "fincast_top2_route_plugin.cu").read_text(encoding="utf-8")
    cmake = (root / "CMakeLists.txt").read_text(encoding="utf-8")

    assert "set(CMAKE_CUDA_ARCHITECTURES 61)" in cmake
    assert "FincastTop2Route" in source
    assert "uniforms" in source
    assert "DataType::kFLOAT" in source
    assert "curand" not in source.lower()
    assert "cudaMalloc" not in source


def test_fp32_builder_disables_lower_precisions_and_obeys_constraints() -> None:
    root = Path(__file__).resolve().parents[1] / "tensorrt"
    source = (root / "build_fp32.py").read_text(encoding="utf-8")
    benchmark = (root / "benchmark_int8.py").read_text(encoding="utf-8")
    summary = (root / "summarize_fp32.py").read_text(encoding="utf-8")

    assert "clear_flag(trt.BuilderFlag.TF32)" in source
    assert "clear_flag(trt.BuilderFlag.FP16)" in source
    assert "clear_flag(trt.BuilderFlag.INT8)" in source
    assert "set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)" in source
    assert "layer.precision = trt.float32" in source
    assert "FinCastCalibrator" not in source
    assert '"--backend"' in benchmark
    assert '"tensorrt_fp32"' in benchmark
    assert 'inspector_int8_layer_count": int8_layers' in summary
    assert 'inspector_fp16_layer_count": fp16_layers' in summary
    assert "strict FP32 inspector found lower precision" in summary


def test_tensorrt_runtime_is_fixed_binary_local_and_digest_pinned() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "portfolio_ai_worker"
    parent = (root / "tensorrt_process.py").read_text(encoding="utf-8")
    child = (root / "_tensorrt_runtime_worker.py").read_text(encoding="utf-8")

    assert 'struct.Struct("<4sII")' in parent
    assert 'struct.Struct("<4sIdd")' in parent
    assert "AI_FINCAST_TENSORRT_FP32_ENGINE_SHA256" in parent
    assert "AI_FINCAST_TENSORRT_PLUGIN_SHA256" in parent
    assert "websocket" not in parent.lower()
    assert "requests" not in parent.lower()
    assert "BATCH_SIZE = 48" in child
    assert "cadence != 60" in child
    assert "execute_async_v2" in child


def test_routing_plugin_cpu_oracle_matches_the_pytorch_router() -> None:
    torch.manual_seed(23)
    gate = nn.Module()
    gate.top_n = 2
    gate.num_gates = 4
    gate.eps = 1e-9
    gate.capacity_factor_eval = 2.0
    gate.differentiable_topk = False
    gate.straight_through_dispatch_tensor = True
    gate.to_gates = nn.Linear(7, 4, bias=False)
    gate.register_buffer("threshold_eval", torch.tensor([1e-9, 0.2]))
    gate.register_buffer("zero", torch.zeros(1))
    gate.topk = lambda values, k: torch.topk(values, k=k, dim=-1)
    gate.eval()
    values = torch.randn(3, 16, 7)
    uniforms = torch.rand(1, 1, 2, 3, 16).clamp(1e-6, 1 - 1e-6)
    gate._fincast_raw_routing_cursor = RoutingCursor(uniforms, layers=1)

    dispatch, combine, _balance, _router = _stateless_gate_forward(gate, values)
    probabilities = gate.to_gates(values).softmax(dim=-1).detach().numpy()
    expected_dispatch, expected_combine = top2_route_reference(
        probabilities,
        uniforms[0, 0].numpy(),
    )

    np.testing.assert_allclose(
        dispatch.detach().numpy(),
        expected_dispatch,
        rtol=1e-6,
        atol=1e-6,
    )
    np.testing.assert_allclose(
        combine.detach().numpy(),
        expected_combine,
        rtol=2e-6,
        atol=2e-6,
    )


def test_onnx_route_oracle_matches_the_plugin_reference() -> None:
    generator = torch.Generator().manual_seed(47)
    probabilities = torch.rand((5, 16, 4), generator=generator).softmax(dim=-1)
    uniforms = torch.rand((2, 5, 16), generator=generator).clamp(1e-6, 1 - 1e-6)

    dispatch, combine = _TensorRTRoute.apply(probabilities, uniforms)
    expected_dispatch, expected_combine = top2_route_reference(
        probabilities.numpy(),
        uniforms.numpy(),
    )

    np.testing.assert_allclose(dispatch.numpy(), expected_dispatch, rtol=0, atol=0)
    np.testing.assert_allclose(combine.numpy(), expected_combine, rtol=2e-6, atol=2e-6)
