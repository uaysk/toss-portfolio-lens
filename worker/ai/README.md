# Toss Portfolio Lens AI worker

This process is the isolated, offline inference boundary for intraday forecasts. It never places orders and it does not
make a buy/sell decision. The Node control plane sends versioned `scalping-ai/v1` JSON requests to the authenticated
WebSocket endpoint `/ws/scalping-ai/v1`. A worker may run on the same internal Compose network or on a separately
managed GPU host without changing the forecasting contract.

## Runtime policy

- Production loads only local snapshots whose revision marker matches `model-manifest.json`. Hub downloads and
  telemetry are disabled before model loading. Missing or incomplete snapshots produce `MODEL_UNAVAILABLE`; no values
  are synthesized.
- Runtime startup and requests never download weights. `scripts/prepare-ai-model-cache.py` is a separate, explicit
  operator action and currently prepares only the pinned Chronos-Bolt-small fallback.
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
portfolio-ai-worker healthcheck
portfolio-ai-worker preflight-json
portfolio-ai-worker forecast-json < request.json
```

`serve` listens using `AI_WEBSOCKET_HOST`, `AI_WEBSOCKET_PORT`, and `AI_WEBSOCKET_PATH`. Every upgrade request must
authenticate with the bearer token stored in `AI_WEBSOCKET_AUTH_TOKEN_FILE`. The default local Compose stack lets the
worker create that token atomically in a private named volume; a remote worker must receive a pre-provisioned token and
set `AI_WEBSOCKET_GENERATE_AUTH_TOKEN=false`. A token value must never be placed in an environment variable, image,
repository, command output, or log.

Other important configuration is environment-backed: `AI_WEBSOCKET_MAX_CONNECTIONS`,
`AI_WEBSOCKET_QUEUE_CAPACITY`, `AI_WEBSOCKET_MAX_IN_FLIGHT`, `AI_WEBSOCKET_PING_INTERVAL_SECONDS`,
`AI_WEBSOCKET_PING_TIMEOUT_SECONDS`, `AI_WEBSOCKET_CLOSE_TIMEOUT_SECONDS`, `AI_WEBSOCKET_TLS_CERT_FILE`,
`AI_WEBSOCKET_TLS_KEY_FILE`, `AI_MODEL_CACHE_DIR`, `AI_DEVICE`, `AI_ALLOW_CPU_FALLBACK`,
`AI_EXPECTED_CUDA_CAPABILITY`, `AI_MICROBATCH_SIZE`, `AI_MAX_SERIES`, `AI_MAX_EVALUATION_ORIGINS`,
`AI_MIN_CONTEXT_BARS`, `AI_MAX_CONTEXT_BARS`, `AI_KRONOS_SAMPLE_COUNT`, `AI_MAX_REQUEST_BYTES`, and
`AI_MAX_RESPONSE_BYTES`.

## Explicit fallback cache preparation

Run this only on an operator workstation or GPU host where outbound Hugging Face access is intentionally allowed. The
script reads the repository manifest, downloads the exact pinned revision into a temporary sibling directory, verifies
regular `config.json` and `model.safetensors` files, writes `.revision` atomically, and then installs the completed
directory. It does not replace an existing invalid directory.

```bash
uv run --python 3.12 --with huggingface-hub==0.33.1 \
  python scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache

python3 scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache \
  --check-only
```

This preparation path supports `chronos-bolt-small` only. Kronos-small still requires its pinned source, tokenizer, and
model snapshot to be acquired and reviewed separately. Set `AI_MODEL_PRIMARY=chronos-bolt-small` when only the prepared
fallback directory is present. The cache directory must be traversable by container UID 10001 (normally directory mode
`0755`); the preparation script makes the public required artifacts read-only. The cache is mounted read-only into the
runtime container.
