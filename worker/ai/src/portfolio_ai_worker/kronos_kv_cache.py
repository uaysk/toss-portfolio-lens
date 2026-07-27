from __future__ import annotations

from typing import Any, Sequence

KRONOS_SOURCE_REVISION = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"
KRONOS_BASE_LOADER_VERSION = "kronos-source-67b630e"
KRONOS_KV_CACHE_VERSION = "kv-cache-v1"
KRONOS_KV_CACHE_LOADER_VERSION = f"kronos-source-67b630e-{KRONOS_KV_CACHE_VERSION}"
_PATCH_MARKER = "_portfolio_lens_kv_cache_version"


class KronosKvCacheCompatibilityError(RuntimeError):
    pass


def _require_attributes(value: Any, names: Sequence[str], label: str) -> None:
    missing = [name for name in names if not hasattr(value, name)]
    if missing:
        raise KronosKvCacheCompatibilityError(
            f"pinned Kronos {label} is missing reviewed attributes: {', '.join(missing)}"
        )


def _validate_model_surface(model: Any) -> None:
    _require_attributes(
        model,
        (
            "embedding",
            "time_emb",
            "token_drop",
            "transformer",
            "norm",
            "dep_layer",
            "head",
        ),
        "model",
    )
    layers = tuple(model.transformer)
    if not layers:
        raise KronosKvCacheCompatibilityError("pinned Kronos model has no transformer layers")
    for index, layer in enumerate(layers):
        _require_attributes(layer, ("norm1", "self_attn", "norm2", "ffn"), f"transformer layer {index}")
        _require_attributes(
            layer.self_attn,
            (
                "q_proj",
                "k_proj",
                "v_proj",
                "out_proj",
                "rotary",
                "n_heads",
                "head_dim",
                "d_model",
                "attn_dropout_p",
                "resid_dropout",
            ),
            f"self-attention layer {index}",
        )
    _require_attributes(model.dep_layer, ("cross_attn", "norm"), "dependency layer")
    _require_attributes(
        model.dep_layer.cross_attn,
        (
            "q_proj",
            "k_proj",
            "v_proj",
            "out_proj",
            "rotary",
            "n_heads",
            "head_dim",
            "d_model",
            "attn_dropout_p",
            "resid_dropout",
        ),
        "dependency cross-attention",
    )
    _require_attributes(model.head, ("__call__", "cond_forward"), "dual head")


def _project(attention: Any, x: Any) -> tuple[Any, Any, Any]:
    batch_size, seq_len, _ = x.shape

    def heads(projection: Any) -> Any:
        return (
            projection(x)
            .view(batch_size, seq_len, attention.n_heads, attention.head_dim)
            .transpose(1, 2)
        )

    return heads(attention.q_proj), heads(attention.k_proj), heads(attention.v_proj)


def _merge_heads(attention: Any, value: Any) -> Any:
    batch_size, _, seq_len, _ = value.shape
    return value.transpose(1, 2).contiguous().view(batch_size, seq_len, attention.d_model)


def _rotary_at(attention: Any, q: Any, k: Any, position: int, torch: Any) -> tuple[Any, Any]:
    rotary = attention.rotary
    _require_attributes(rotary, ("inv_freq", "_rotate_half"), "rotary embedding")
    positions = torch.arange(position, position + 1, device=q.device).type_as(rotary.inv_freq)
    frequencies = torch.einsum("i,j->ij", positions, rotary.inv_freq)
    embedding = torch.cat((frequencies, frequencies), dim=-1).to(q.device)
    cos = embedding.cos()[None, None, :, :]
    sin = embedding.sin()[None, None, :, :]
    return (
        (q * cos) + (rotary._rotate_half(q) * sin),
        (k * cos) + (rotary._rotate_half(k) * sin),
    )


def _prefill_attention(attention: Any, x: Any, functional: Any) -> tuple[Any, Any, Any]:
    q, k, v = _project(attention, x)
    q, k = attention.rotary(q, k)
    output = functional.scaled_dot_product_attention(
        q,
        k,
        v,
        attn_mask=None,
        dropout_p=attention.attn_dropout_p if attention.training else 0.0,
        is_causal=True,
    )
    projected = attention.resid_dropout(attention.out_proj(_merge_heads(attention, output)))
    return projected, k, v


def _prefill(
    model: Any,
    pre_tokens: Any,
    post_tokens: Any,
    stamp: Any,
    functional: Any,
) -> tuple[Any, Any, tuple[tuple[Any, Any], ...]]:
    x = model.embedding([pre_tokens, post_tokens])
    if stamp is not None:
        x = x + model.time_emb(stamp)
    x = model.token_drop(x)
    caches: list[tuple[Any, Any]] = []
    for layer in model.transformer:
        residual = x
        attention_output, k, v = _prefill_attention(layer.self_attn, layer.norm1(x), functional)
        x = residual + attention_output
        residual = x
        x = residual + layer.ffn(layer.norm2(x))
        caches.append((k, v))
    context = model.norm(x)
    return model.head(context), context, tuple(caches)


def _append_token(
    model: Any,
    pre_token: Any,
    post_token: Any,
    stamp: Any,
    caches: Sequence[tuple[Any, Any]],
    *,
    position: int,
    max_context: int,
    torch: Any,
    functional: Any,
) -> tuple[Any, Any, tuple[tuple[Any, Any], ...]]:
    x = model.embedding([pre_token, post_token])
    if stamp is not None:
        x = x + model.time_emb(stamp)
    x = model.token_drop(x)
    next_caches: list[tuple[Any, Any]] = []
    if len(caches) != len(model.transformer):
        raise KronosKvCacheCompatibilityError("Kronos layer cache count is inconsistent")
    for layer, (cached_k, cached_v) in zip(model.transformer, caches, strict=True):
        residual = x
        normalized = layer.norm1(x)
        q, new_k, new_v = _project(layer.self_attn, normalized)
        q, new_k = _rotary_at(layer.self_attn, q, new_k, position, torch)
        k = torch.cat((cached_k, new_k), dim=-2)[..., -max_context:, :]
        v = torch.cat((cached_v, new_v), dim=-2)[..., -max_context:, :]
        # The cache contains only past/current keys, so the single query must
        # attend every cached position. A top-left causal mask would expose
        # only the first key for a non-square 1xN attention matrix.
        output = functional.scaled_dot_product_attention(
            q,
            k,
            v,
            attn_mask=None,
            dropout_p=layer.self_attn.attn_dropout_p if layer.self_attn.training else 0.0,
            is_causal=False,
        )
        attention_output = layer.self_attn.resid_dropout(
            layer.self_attn.out_proj(_merge_heads(layer.self_attn, output))
        )
        x = residual + attention_output
        residual = x
        x = residual + layer.ffn(layer.norm2(x))
        next_caches.append((k, v))
    context = model.norm(x)
    return model.head(context), context, tuple(next_caches)


def _decode_s2_last(model: Any, context: Any, sample_pre: Any, functional: Any) -> Any:
    sibling = model.embedding.emb_s1(sample_pre)
    attention = model.dep_layer.cross_attn
    batch_size, query_len, _ = sibling.shape
    _, key_len, _ = context.shape

    def heads(projection: Any, value: Any, seq_len: int) -> Any:
        return (
            projection(value)
            .view(batch_size, seq_len, attention.n_heads, attention.head_dim)
            .transpose(1, 2)
        )

    q = heads(attention.q_proj, sibling, query_len)
    k = heads(attention.k_proj, context, key_len)
    v = heads(attention.v_proj, context, key_len)
    # Preserve the pinned upstream cross-attention behavior: its rotary helper
    # uses q_len for both q and k, broadcasting position zero across cached keys.
    q, k = attention.rotary(q, k)
    output = functional.scaled_dot_product_attention(
        q,
        k,
        v,
        attn_mask=None,
        dropout_p=attention.attn_dropout_p if attention.training else 0.0,
        is_causal=attention.training,
    )
    attention_output = attention.resid_dropout(
        attention.out_proj(_merge_heads(attention, output))
    )
    last = model.dep_layer.norm(context[:, -1:, :] + attention_output)
    return model.head.cond_forward(last)


def _cached_auto_regressive_inference(
    kronos_module: Any,
    tokenizer: Any,
    model: Any,
    x: Any,
    x_stamp: Any,
    y_stamp: Any,
    max_context: int,
    pred_len: int,
    clip: float = 5,
    temperature: float = 1.0,
    top_k: int = 0,
    top_p: float = 0.99,
    sample_count: int = 5,
    verbose: bool = False,
) -> Any:
    del verbose
    torch = kronos_module.torch
    functional = kronos_module.F
    numpy = kronos_module.np
    if max_context < 1 or pred_len < 1 or sample_count < 1:
        raise ValueError("Kronos cache requires positive context, prediction, and sample counts")

    with torch.no_grad():
        x = torch.clip(x, -clip, clip)
        device = x.device
        x = x.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(
            -1,
            x.size(1),
            x.size(2),
        ).to(device)
        x_stamp = x_stamp.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(
            -1,
            x_stamp.size(1),
            x_stamp.size(2),
        ).to(device)
        y_stamp = y_stamp.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(
            -1,
            y_stamp.size(1),
            y_stamp.size(2),
        ).to(device)
        x_token = tokenizer.encode(x, half=True)
        initial_seq_len = x.size(1)
        batch_size = x_token[0].size(0)
        total_seq_len = initial_seq_len + pred_len
        full_stamp = torch.cat([x_stamp, y_stamp], dim=1)
        generated_pre = x_token[0].new_empty(batch_size, pred_len)
        generated_post = x_token[1].new_empty(batch_size, pred_len)

        window_len = min(initial_seq_len, max_context)
        if window_len < 1:
            raise ValueError("Kronos cache requires at least one input token")
        start = initial_seq_len - window_len
        pre_tokens = x_token[0][:, start:initial_seq_len].contiguous()
        post_tokens = x_token[1][:, start:initial_seq_len].contiguous()
        current_stamp = full_stamp[:, start:initial_seq_len, :].contiguous()
        s1_logits, context, caches = _prefill(
            model,
            pre_tokens,
            post_tokens,
            current_stamp,
            functional,
        )
        next_position = window_len

        for index in range(pred_len):
            sample_pre = kronos_module.sample_from_logits(
                s1_logits[:, -1, :],
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                sample_logits=True,
            )
            s2_logits = _decode_s2_last(model, context, sample_pre, functional)
            sample_post = kronos_module.sample_from_logits(
                s2_logits[:, -1, :],
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                sample_logits=True,
            )
            generated_pre[:, index] = sample_pre.squeeze(-1)
            generated_post[:, index] = sample_post.squeeze(-1)

            if index + 1 < pred_len:
                s1_logits, next_context, caches = _append_token(
                    model,
                    sample_pre,
                    sample_post,
                    y_stamp[:, index : index + 1, :],
                    caches,
                    position=next_position,
                    max_context=max_context,
                    torch=torch,
                    functional=functional,
                )
                next_position += 1
                context = torch.cat((context, next_context), dim=1)[:, -max_context:, :]

        full_pre = torch.cat([x_token[0], generated_pre], dim=1)
        full_post = torch.cat([x_token[1], generated_post], dim=1)
        decode_start = max(0, total_seq_len - max_context)
        input_tokens = [
            full_pre[:, decode_start:total_seq_len].contiguous(),
            full_post[:, decode_start:total_seq_len].contiguous(),
        ]
        decoded = tokenizer.decode(input_tokens, half=True)
        decoded = decoded.reshape(-1, sample_count, decoded.size(1), decoded.size(2))
        predictions = decoded.cpu().numpy()
        return numpy.mean(predictions, axis=1)


def install_kronos_kv_cache(
    kronos_module: Any,
    model: Any,
    *,
    source_revision: str,
) -> None:
    if source_revision != KRONOS_SOURCE_REVISION:
        raise KronosKvCacheCompatibilityError(
            "Kronos K/V cache is approved only for source revision "
            f"{KRONOS_SOURCE_REVISION}"
        )
    _require_attributes(
        kronos_module,
        ("torch", "F", "np", "sample_from_logits", "auto_regressive_inference"),
        "module",
    )
    _validate_model_surface(model)
    existing = getattr(kronos_module.auto_regressive_inference, _PATCH_MARKER, None)
    if existing == KRONOS_KV_CACHE_VERSION:
        return
    if existing is not None:
        raise KronosKvCacheCompatibilityError(
            f"Kronos module already has an incompatible cache patch: {existing}"
        )

    def cached(
        tokenizer: Any,
        current_model: Any,
        x: Any,
        x_stamp: Any,
        y_stamp: Any,
        max_context: int,
        pred_len: int,
        clip: float = 5,
        T: float = 1.0,
        top_k: int = 0,
        top_p: float = 0.99,
        sample_count: int = 5,
        verbose: bool = False,
    ) -> Any:
        _validate_model_surface(current_model)
        return _cached_auto_regressive_inference(
            kronos_module,
            tokenizer,
            current_model,
            x,
            x_stamp,
            y_stamp,
            max_context,
            pred_len,
            clip,
            T,
            top_k,
            top_p,
            sample_count,
            verbose,
        )

    setattr(cached, _PATCH_MARKER, KRONOS_KV_CACHE_VERSION)
    kronos_module.auto_regressive_inference = cached
