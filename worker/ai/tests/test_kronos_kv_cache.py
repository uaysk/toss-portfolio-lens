from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
import pytest
import torch
from torch import nn
from torch.nn import functional as F

from portfolio_ai_worker.kronos_kv_cache import (
    KRONOS_KV_CACHE_VERSION,
    KRONOS_SOURCE_REVISION,
    KronosKvCacheCompatibilityError,
    _append_token,
    _decode_s2_last,
    _prefill,
    install_kronos_kv_cache,
)


class _RmsNorm(nn.Module):
    def __init__(self, dimension: int) -> None:
        super().__init__()
        self.eps = 1e-5
        self.weight = nn.Parameter(torch.ones(dimension))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        normalized = x.float() * torch.rsqrt(
            torch.mean(x.float() * x.float(), dim=-1, keepdim=True) + self.eps
        )
        return normalized.type_as(x) * self.weight


class _Rotary(nn.Module):
    def __init__(self, dimension: int) -> None:
        super().__init__()
        inverse = 1.0 / (10_000 ** (torch.arange(0, dimension, 2).float() / dimension))
        self.register_buffer("inv_freq", inverse)

    @staticmethod
    def _rotate_half(x: torch.Tensor) -> torch.Tensor:
        first, second = x.chunk(2, dim=-1)
        return torch.cat((-second, first), dim=-1)

    def forward(
        self,
        q: torch.Tensor,
        k: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        positions = torch.arange(q.shape[-2], device=q.device).type_as(self.inv_freq)
        frequencies = torch.einsum("i,j->ij", positions, self.inv_freq)
        embedding = torch.cat((frequencies, frequencies), dim=-1).to(q.device)
        cos = embedding.cos()[None, None, :, :]
        sin = embedding.sin()[None, None, :, :]
        return (
            (q * cos) + (self._rotate_half(q) * sin),
            (k * cos) + (self._rotate_half(k) * sin),
        )


class _Attention(nn.Module):
    def __init__(self, dimension: int, heads: int) -> None:
        super().__init__()
        self.d_model = dimension
        self.n_heads = heads
        self.head_dim = dimension // heads
        self.q_proj = nn.Linear(dimension, dimension)
        self.k_proj = nn.Linear(dimension, dimension)
        self.v_proj = nn.Linear(dimension, dimension)
        self.out_proj = nn.Linear(dimension, dimension)
        self.rotary = _Rotary(self.head_dim)
        self.attn_dropout_p = 0.0
        self.resid_dropout = nn.Dropout(0.0)

    def _heads(self, projection: nn.Linear, value: torch.Tensor) -> torch.Tensor:
        batch, length, _ = value.shape
        return (
            projection(value)
            .view(batch, length, self.n_heads, self.head_dim)
            .transpose(1, 2)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        q = self._heads(self.q_proj, x)
        k = self._heads(self.k_proj, x)
        v = self._heads(self.v_proj, x)
        q, k = self.rotary(q, k)
        output = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        batch, _, length, _ = output.shape
        merged = output.transpose(1, 2).contiguous().view(batch, length, self.d_model)
        return self.resid_dropout(self.out_proj(merged))


class _CrossAttention(_Attention):
    def forward(
        self,
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
    ) -> torch.Tensor:
        q = self._heads(self.q_proj, query)
        k = self._heads(self.k_proj, key)
        v = self._heads(self.v_proj, value)
        q, k = self.rotary(q, k)
        output = F.scaled_dot_product_attention(q, k, v, is_causal=self.training)
        batch, _, length, _ = output.shape
        merged = output.transpose(1, 2).contiguous().view(batch, length, self.d_model)
        return self.resid_dropout(self.out_proj(merged))


class _Block(nn.Module):
    def __init__(self, dimension: int, heads: int) -> None:
        super().__init__()
        self.norm1 = _RmsNorm(dimension)
        self.self_attn = _Attention(dimension, heads)
        self.norm2 = _RmsNorm(dimension)
        self.ffn = nn.Sequential(
            nn.Linear(dimension, dimension * 2, bias=False),
            nn.SiLU(),
            nn.Linear(dimension * 2, dimension, bias=False),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.self_attn(self.norm1(x))
        return x + self.ffn(self.norm2(x))


class _Embedding(nn.Module):
    def __init__(self, vocabulary: int, dimension: int) -> None:
        super().__init__()
        self.d_model = dimension
        self.emb_s1 = nn.Embedding(vocabulary, dimension)
        self.emb_s2 = nn.Embedding(vocabulary, dimension)
        self.fusion_proj = nn.Linear(dimension * 2, dimension)

    def forward(self, tokens: list[torch.Tensor]) -> torch.Tensor:
        first, second = tokens
        scale = math.sqrt(self.d_model)
        return self.fusion_proj(
            torch.cat((self.emb_s1(first) * scale, self.emb_s2(second) * scale), dim=-1)
        )


class _Head(nn.Module):
    def __init__(self, dimension: int, vocabulary: int) -> None:
        super().__init__()
        self.proj_s1 = nn.Linear(dimension, vocabulary)
        self.proj_s2 = nn.Linear(dimension, vocabulary)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj_s1(x)

    def cond_forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj_s2(x)


class _DependencyLayer(nn.Module):
    def __init__(self, dimension: int, heads: int) -> None:
        super().__init__()
        self.cross_attn = _CrossAttention(dimension, heads)
        self.norm = _RmsNorm(dimension)

    def forward(
        self,
        hidden: torch.Tensor,
        sibling: torch.Tensor,
    ) -> torch.Tensor:
        return self.norm(hidden + self.cross_attn(sibling, hidden, hidden))


class _TinyKronos(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        dimension = 16
        vocabulary = 8
        self.embedding = _Embedding(vocabulary, dimension)
        self.time_emb = nn.Linear(5, dimension, bias=False)
        self.token_drop = nn.Dropout(0.0)
        self.transformer = nn.ModuleList([_Block(dimension, 4), _Block(dimension, 4)])
        self.norm = _RmsNorm(dimension)
        self.dep_layer = _DependencyLayer(dimension, 4)
        self.head = _Head(dimension, vocabulary)

    def decode_s1(
        self,
        first: torch.Tensor,
        second: torch.Tensor,
        stamp: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.token_drop(self.embedding([first, second]) + self.time_emb(stamp))
        for layer in self.transformer:
            x = layer(x)
        context = self.norm(x)
        return self.head(context), context

    def decode_s2(self, context: torch.Tensor, first: torch.Tensor) -> torch.Tensor:
        sibling = self.embedding.emb_s1(first)
        return self.head.cond_forward(self.dep_layer(context, sibling))


def _inputs(length: int = 6) -> tuple[_TinyKronos, torch.Tensor, torch.Tensor, torch.Tensor]:
    torch.manual_seed(42)
    model = _TinyKronos().eval()
    first = torch.randint(0, 8, (2, length))
    second = torch.randint(0, 8, (2, length))
    stamp = torch.randn(2, length, 5)
    return model, first, second, stamp


def test_prefill_and_non_sliding_increment_match_pinned_full_decode() -> None:
    model, first, second, stamp = _inputs()

    expected_logits, expected_context = model.decode_s1(first, second, stamp)
    logits, context, caches = _prefill(model, first, second, stamp, F)

    torch.testing.assert_close(logits, expected_logits, rtol=1e-6, atol=1e-6)
    torch.testing.assert_close(context, expected_context, rtol=1e-6, atol=1e-6)

    next_first = torch.randint(0, 8, (2, 1))
    next_second = torch.randint(0, 8, (2, 1))
    next_stamp = torch.randn(2, 1, 5)
    incremental_logits, incremental_context, _ = _append_token(
        model,
        next_first,
        next_second,
        next_stamp,
        caches,
        position=first.shape[1],
        max_context=16,
        torch=torch,
        functional=F,
    )
    full_logits, full_context = model.decode_s1(
        torch.cat((first, next_first), dim=1),
        torch.cat((second, next_second), dim=1),
        torch.cat((stamp, next_stamp), dim=1),
    )

    torch.testing.assert_close(incremental_logits, full_logits[:, -1:, :], rtol=2e-5, atol=2e-5)
    torch.testing.assert_close(incremental_context, full_context[:, -1:, :], rtol=2e-5, atol=2e-5)


def test_dependency_decode_computes_only_last_position_without_changing_logits() -> None:
    model, first, second, stamp = _inputs()
    _, context = model.decode_s1(first, second, stamp)
    sample_first = torch.randint(0, 8, (2, 1))

    expected = model.decode_s2(context, sample_first)[:, -1:, :]
    actual = _decode_s2_last(model, context, sample_first, F)

    torch.testing.assert_close(actual, expected, rtol=1e-6, atol=1e-6)


def test_installation_is_revision_gated_and_idempotent() -> None:
    model, *_ = _inputs()
    module = SimpleNamespace(
        torch=torch,
        F=F,
        np=np,
        sample_from_logits=lambda logits, **_kwargs: logits.argmax(dim=-1, keepdim=True),
        auto_regressive_inference=lambda *_args, **_kwargs: None,
    )

    with pytest.raises(KronosKvCacheCompatibilityError, match="approved only"):
        install_kronos_kv_cache(module, model, source_revision="unreviewed")

    install_kronos_kv_cache(module, model, source_revision=KRONOS_SOURCE_REVISION)
    patched = module.auto_regressive_inference
    assert getattr(patched, "_portfolio_lens_kv_cache_version") == KRONOS_KV_CACHE_VERSION

    install_kronos_kv_cache(module, model, source_revision=KRONOS_SOURCE_REVISION)
    assert module.auto_regressive_inference is patched
