# Toss Portfolio Lens AI worker

The AI worker is the isolated, offline inference boundary for FinCast and
Chronos-2. It never places orders. The Node control plane sends strict
`scalping-ai/v2` messages over the authenticated `/ws/scalping-ai/v2`
WebSocket endpoint.

## Runtime policy

- A process runs exactly one manifest-pinned lane: `Vincent05R/FinCast`
  (`fincast`) or `amazon/chronos-2` (`chronos_2`).
- Startup and requests never download weights. Missing, incomplete, or
  revision-mismatched cache entries fail closed with `MODEL_UNAVAILABLE`.
- Every run records its confirmed input window, SHA-256 input digest, model
  and source revisions, device, precision policy, generation time, and
  latency.
- Production CUDA execution requires the configured device identity
  (default `Tesla P40`), compute capability `6.1`, and a compatible PyTorch
  cubin. A production lane that resolves to CPU is unavailable.
- FinCast uses exactly 512 confirmed bars and its separately qualified
  FP32/mixed-FP16 artifacts. Qualification or VRAM failures select only the
  validated FP32 artifact or fail closed.
- Chronos-2 uses `chronos-forecasting==2.3.1`, the pinned model revision,
  FP32 math attention, monotone quantile rearrangement, and one of the
  validated 512/1024/2048/4096/8192-bar contexts.
- Input bars are complete, strictly increasing, timezone-aware OHLCV data.
  The wire contract fixes 5, 15, 30, and 60 minute horizons and the seven
  policy quantiles.

## Offline cache

`AI_MODEL_CACHE_DIR` is mounted read-only and contains:

```text
fincast-source/.source-revision
fincast-source/.source-archive-sha256
fincast-source/src/ffm/pytorch_patched_decoder_MOE.py
fincast-source/src/st_moe_pytorch/st_moe_pytorch.py
fincast/.revision
fincast/model.fp32.safetensors
fincast/model.mixed-fp16.safetensors
fincast/precision-validation.json
chronos-2/.revision
chronos-2/config.json
chronos-2/model.safetensors
```

Each marker must match `model-manifest.json`. Cache preparation is an explicit
operator action; images and running workers do not access model hubs.

## Commands

```text
portfolio-ai-worker serve
portfolio-ai-worker healthcheck
portfolio-ai-worker preflight-json
portfolio-ai-worker forecast-json < request.json
portfolio-ai-worker raw-generate --job /absolute/input/manifest.json --output /absolute/run-directory --resume
portfolio-ai-worker raw-benchmark --job /absolute/input/manifest.json --output /absolute/result.json \
  --backend eager --batch-size 16 --rounds 3 --warmups 10 --iterations 30
portfolio-ai-worker raw-compatibility --job /absolute/input/manifest.json --output /absolute/result.json
```

`serve` reads `AI_WEBSOCKET_HOST`, `AI_WEBSOCKET_PORT`,
`AI_WEBSOCKET_PATH`, and a bearer token from
`AI_WEBSOCKET_AUTH_TOKEN_FILE`. Tokens must not appear in environment values,
images, repository files, command output, or logs.

Lane-specific settings use the `AI_FINCAST_*` and `AI_CHRONOS2_*` prefixes.
`AI_CROSS_REQUEST_MICROBATCH` is disabled by default. When enabled, the
scheduler coalesces only requests with identical lane, revision, profile,
shape, horizons, quantiles, and seed.

Prepare Chronos-2 explicitly on a host where model-hub access is authorized:

```bash
uv run --python 3.12 --with huggingface-hub \
  python scripts/prepare-chronos2-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache
```

The FinCast source and qualified artifacts are provisioned from their pinned,
checksum-verified qualification outputs. The cache must be readable by
container UID 10001.
