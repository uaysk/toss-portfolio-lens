# Toss Portfolio Lens AI worker

This process is the isolated, offline inference boundary for intraday forecasts. It never places orders and it does not
make a buy/sell decision. The Node control plane sends versioned `scalping-ai/v1` requests over a four-byte,
big-endian-length-prefixed Unix-domain socket. Forecast and retrospective evaluation responses use the same framing.

## Runtime policy

- Production loads only local snapshots whose revision marker matches `model-manifest.json`. Hub downloads and
  telemetry are disabled before model loading. Missing or incomplete snapshots produce `MODEL_UNAVAILABLE`; no values
  are synthesized.
- The primary model is pinned Kronos-small with the pinned Kronos tokenizer and source loader. Chronos-Bolt-small is a
  startup-only fallback. A running process never silently switches models between requests.
- P40 execution uses float32 and the math scaled-dot-product-attention backend. CUDA compute capability `6.1` is checked
  against the installed PyTorch wheel. `AI_ALLOW_CPU_FALLBACK` controls startup CPU fallback.
- A deterministic adapter exists only in tests and is dependency-injected. It is not selectable by environment variable
  or through the wire contract.
- Input bars must be complete, strictly ordered, timezone-aware OHLC bars. Forecasts always cover 5, 15, 30, and 60
  minutes with fixed 5/10/25/50/75/90/95 percentiles.
- Distribution-shift output remains explicitly unavailable until reproducible training-reference statistics are
  published by the selected model. First-passage probabilities are unavailable for Chronos marginal quantiles because
  marginal distributions do not identify target-versus-stop path ordering.

## Offline cache layout

The read-only `AI_MODEL_CACHE_DIR` mount must contain:

```text
kronos-source/.source-revision
kronos-source/model/kronos.py
kronos-source/model/module.py
kronos-source/LICENSE
kronos-small/.revision
kronos-small/config.json
kronos-small/model.safetensors
kronos-tokenizer-base/.revision
kronos-tokenizer-base/config.json
kronos-tokenizer-base/model.safetensors
chronos-bolt-small/.revision
chronos-bolt-small/config.json
chronos-bolt-small/model.safetensors
```

Each marker contains the exact commit or model revision from `model-manifest.json`. Model acquisition is intentionally a
separate, reviewed operation; the image build and worker perform no model download.

## Commands

```text
portfolio-ai-worker serve
portfolio-ai-worker preflight-json
portfolio-ai-worker forecast-json < request.json
```

Important configuration is environment-backed: `AI_COMPUTE_SOCKET`, `AI_MODEL_CACHE_DIR`, `AI_DEVICE`,
`AI_ALLOW_CPU_FALLBACK`, `AI_EXPECTED_CUDA_CAPABILITY`, `AI_MICROBATCH_SIZE`, `AI_MAX_SERIES`,
`AI_MAX_EVALUATION_ORIGINS`, `AI_MIN_CONTEXT_BARS`, `AI_MAX_CONTEXT_BARS`, `AI_KRONOS_SAMPLE_COUNT`,
`AI_MAX_REQUEST_BYTES`, and `AI_MAX_RESPONSE_BYTES`.
