# Toss Portfolio Lens AI worker

This process is the isolated, offline inference boundary for intraday forecasts. It never places orders and does not
make a buy/sell decision. The Node control plane sends versioned `scalping-ai/v1` requests to the authenticated
WebSocket endpoint `/ws/scalping-ai/v1`.

## Runtime policy

- Each process runs exactly one manifest-pinned lane: `NeoQuasar/Kronos-base` (`kronos_base`) or
  `Vincent05R/FinCast` (`fincast`). Forecast and evaluate responses contain one independent `model_runs` item; the
  top-level model, status, and series mirror that item.
- Runtime startup and requests never download weights. Hub downloads and telemetry are disabled before loading.
  Missing, incomplete, or revision-mismatched cache entries return `MODEL_UNAVAILABLE`; no prediction or fallback is
  fabricated.
- Every run records the exact context start, input end, confirmed-bar count, canonical input SHA-256 digest, pinned
  model/tokenizer/source revisions, generation time, device, and latency.
- Kronos P40 execution uses float32 and the math scaled-dot-product-attention backend. The CUDA device name must exactly match
  `AI_EXPECTED_CUDA_DEVICE_NAME` (default `Tesla P40`), compute capability must match `6.1`, and the installed PyTorch
  wheel must contain a compatible Pascal cubin. Production fails closed if these checks resolve to CPU.
- FinCast uses 512 confirmed close bars and a separately qualified mixed-FP16 safetensors artifact. Attention softmax,
  RMSNorm, router logits, and final post-processing retain FP32 islands. Failure of any fixed 128-context numerical
  gate selects the lossless FP32 safetensors artifact. Missing validation, an artifact SHA mismatch, or insufficient
  NVML headroom fails closed.
- Input bars must be complete, strictly ordered, timezone-aware OHLCV bars. The finance-specific Kronos predictor uses
  the confirmed range only and forecasts fixed 5, 15, 30, and 60 minute horizons with fixed
  5/10/25/50/75/90/95 percentiles.
- A deterministic adapter exists only in tests and is dependency-injected. It is not selectable through configuration
  or the wire contract.

The official model card identifies Kronos-base as the 102.3M-parameter, 512-context model and pairs it with
`NeoQuasar/Kronos-Tokenizer-base`. The exact reviewed revisions are in `model-manifest.json`.

## Offline cache layout

The read-only `AI_MODEL_CACHE_DIR` mount must contain:

```text
kronos-source/.source-revision
kronos-source/model/kronos.py
kronos-source/model/module.py
kronos-source/LICENSE
kronos-base/.revision
kronos-base/config.json
kronos-base/model.safetensors
kronos-tokenizer-base/.revision
kronos-tokenizer-base/config.json
kronos-tokenizer-base/model.safetensors
fincast-source/.source-revision
fincast-source/.source-archive-sha256
fincast-source/src/ffm/pytorch_patched_decoder_MOE.py
fincast-source/src/st_moe_pytorch/st_moe_pytorch.py
fincast/.revision
fincast/model.fp32.safetensors
fincast/model.mixed-fp16.safetensors
fincast/precision-validation.json
```

Each marker must contain the exact revision from `model-manifest.json`. The image build and worker perform no model
download.

## Commands

```text
portfolio-ai-worker serve
portfolio-ai-worker healthcheck
portfolio-ai-worker preflight-json
portfolio-ai-worker forecast-json < request.json
```

`serve` listens using `AI_WEBSOCKET_HOST`, `AI_WEBSOCKET_PORT`, and `AI_WEBSOCKET_PATH`. Every upgrade request must
authenticate with the bearer token stored in `AI_WEBSOCKET_AUTH_TOKEN_FILE`. A token value must never be placed in an
environment variable, image, repository, command output, or log.

Important configuration includes `AI_MODEL_CACHE_DIR`, `AI_MODEL_MANIFEST`, `AI_DEVICE`,
`AI_ALLOW_CPU_FALLBACK`, `AI_EXPECTED_CUDA_CAPABILITY`, `AI_EXPECTED_CUDA_DEVICE_NAME`,
`AI_MICROBATCH_SIZE`, `AI_MAX_SERIES`, `AI_MAX_EVALUATION_ORIGINS`, `AI_MIN_CONTEXT_BARS`,
`AI_MAX_CONTEXT_BARS`, `AI_KRONOS_SAMPLE_COUNT`, `AI_MAX_REQUEST_BYTES`, `AI_MAX_RESPONSE_BYTES`, and the
`AI_WEBSOCKET_*` transport limits.

## Explicit cache preparation

Run this only on an operator workstation or GPU host where outbound Hugging Face access is intentionally allowed:

```bash
uv run --python 3.12 --with huggingface-hub==0.33.1 \
  python scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache

python3 scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache \
  --check-only
```

The script prepares and verifies only the pinned Kronos-base and tokenizer snapshots. The pinned Kronos source tree is
reviewed and provisioned separately under `kronos-source`; runtime validates its revision marker and required files.
The cache directory must be traversable by container UID 10001 and is mounted read-only into the worker.
