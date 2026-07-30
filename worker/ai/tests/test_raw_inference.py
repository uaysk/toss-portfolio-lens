from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from portfolio_ai_worker.fincast import project_native_quantiles
from portfolio_ai_worker.raw_inference import (
    PackedExperts,
    RoutingCursor,
    _stateless_gate_forward,
    native_to_projected_compatibility,
)


class _TopKGate(nn.Module):
    def __init__(self, dimension: int = 8) -> None:
        super().__init__()
        self.top_n = 2
        self.num_gates = 4
        self.eps = 1e-9
        self.capacity_factor_eval = 2.0
        self.differentiable_topk = False
        self.straight_through_dispatch_tensor = True
        self.to_gates = nn.Linear(dimension, 4, bias=False)
        self.register_buffer("threshold_eval", torch.tensor([1e-9, 0.2]))
        self.register_buffer("zero", torch.zeros(1))
        self.topk = lambda values, k: torch.topk(values, k=k, dim=-1)
        self.eval()


class _Expert(nn.Module):
    def __init__(self, dimension: int) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(dimension, dimension)
        self.down_proj = nn.Linear(dimension, dimension)
        self.layer_norm = nn.LayerNorm(dimension, eps=1e-6)

    def forward(self, x: torch.Tensor, paddings: torch.Tensor | None = None) -> torch.Tensor:
        output = self.down_proj(F.relu(self.gate_proj(self.layer_norm(x))))
        if paddings is not None:
            output = output * (1.0 - paddings[..., None])
        return output + x


def _original_experts(dimension: int = 12) -> SimpleNamespace:
    torch.manual_seed(19)
    return SimpleNamespace(
        experts=nn.ModuleList([_Expert(dimension) for _ in range(4)]),
        is_distributed=False,
    )


def test_stateless_gate_consumes_explicit_uniforms_without_rng() -> None:
    torch.manual_seed(7)
    gate = _TopKGate()
    values = torch.randn(3, 16, 8)
    uniforms = torch.full((1, 1, 2, 3, 16), 0.25, dtype=torch.float32)

    gate._fincast_raw_routing_cursor = RoutingCursor(uniforms, layers=1)
    first = _stateless_gate_forward(gate, values)
    torch.manual_seed(999)
    gate._fincast_raw_routing_cursor = RoutingCursor(uniforms.clone(), layers=1)
    second = _stateless_gate_forward(gate, values)

    assert first[0].shape == (3, 16, 4, 8)
    assert first[1].shape == (3, 16, 4, 8)
    torch.testing.assert_close(first[0], second[0], rtol=0, atol=0)
    torch.testing.assert_close(first[1], second[1], rtol=0, atol=0)


def test_packed_experts_preserve_values_semantics_and_use_two_bmm_calls(
    monkeypatch,
) -> None:
    original = _original_experts()
    packed = PackedExperts(original)
    values = torch.randn(2, 4, 8, 12)
    paddings = torch.zeros(2, 4, 8)
    paddings[1, 2, 6:] = 1
    baseline = torch.stack(
        [
            expert(values[:, index], paddings[:, index])
            for index, expert in enumerate(original.experts)
        ],
        dim=1,
    )

    calls = 0
    real_bmm = torch.bmm

    def counted_bmm(left: torch.Tensor, right: torch.Tensor) -> torch.Tensor:
        nonlocal calls
        calls += 1
        return real_bmm(left, right)

    monkeypatch.setattr(torch, "bmm", counted_bmm)
    candidate = packed(values, paddings=paddings)

    assert calls == 2
    assert packed.original_value_digest == packed.packed_value_digest()
    torch.testing.assert_close(candidate, baseline, rtol=2e-6, atol=2e-6)


def test_native_compatibility_projection_matches_fixed_quantile_contract() -> None:
    values = np.zeros((1, 4, 10), dtype=np.float32)
    values[..., 1:] = np.asarray(
        [9, 1, 8, 2, 7, 3, 6, 4, 5],
        dtype=np.float32,
    )
    projected = native_to_projected_compatibility(values)

    assert projected.dtype == np.dtype("<f4")
    assert projected.shape == (1, 4, 7)
    np.testing.assert_array_equal(
        projected[0, 0],
        np.asarray([1, 1, 2.5, 5, 7.5, 9, 9], dtype=np.float32),
    )


def test_native_compatibility_projection_is_byte_exact_with_live_adapter_math() -> None:
    generator = np.random.default_rng(41)
    values = generator.normal(50_000, 2_000, size=(8, 4, 10)).astype(np.float32)
    projected = native_to_projected_compatibility(values)
    expected = np.empty_like(projected)
    for row in range(values.shape[0]):
        for horizon in range(values.shape[1]):
            live = project_native_quantiles(
                [float(value) for value in values[row, horizon, 1:]]
            )
            expected[row, horizon] = np.asarray(tuple(live.values()), dtype=np.float32)

    np.testing.assert_array_equal(projected, expected)
