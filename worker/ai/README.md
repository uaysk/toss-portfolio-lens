# Toss Portfolio Lens AI worker

This process is the isolated, offline inference boundary for intraday forecasts. It never places orders and does not
make a buy/sell decision. The Node control plane sends versioned `scalping-ai/v1` requests to the authenticated
WebSocket endpoint `/ws/scalping-ai/v1`.

## Runtime policy

- Each process runs exactly one manifest-pinned lane: `NeoQuasar/Kronos-base` (`kronos_base`),
  `Vincent05R/FinCast` (`fincast`), or the qualification-only `amazon/chronos-2` (`chronos_2`). Forecast and
  evaluate responses contain one independent `model_runs` item; the top-level model, status, and series mirror it.
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
- Chronos-2 uses the pinned `chronos-forecasting==2.3.1` package, exact model revision, FP32 math attention,
  `cross_learning=False`, and a validated 512/1024/2048/4096/8192-bar context. Its 21 native quantiles are preserved in offline
  artifacts before the seven policy quantiles are selected. It is an explicit challenger and never replaces the
  FinCast live lane automatically.
- The Chronos-2 qualification host has CUDA toolkit 12.2 and cuDNN 8.9.7 headers, while the locked
  `torch==2.6.0+cu124` wheel executes with its bundled CUDA 12.4 and cuDNN 9.1 libraries. `preflight.json` records the
  host toolchain and `runtime.json` records the actual framework runtime separately. Header presence must not be
  reported as the inference runtime, and the result explicitly marks that it is not an exact 12.2/8.9.7 runtime.
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
chronos-2/.revision
chronos-2/config.json
chronos-2/model.safetensors
```

Each marker must contain the exact revision from `model-manifest.json`. The image build and worker perform no model
download.

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
portfolio-ai-worker raw-tensorrt-challenger --job /absolute/input/manifest.json \
  --output /absolute/result.json --plugin-source /absolute/fincast_top2_route_plugin.cu \
  --provenance /absolute/passed-fp32-benchmark.json
```

`serve` listens using `AI_WEBSOCKET_HOST`, `AI_WEBSOCKET_PORT`, and `AI_WEBSOCKET_PATH`. Every upgrade request must
authenticate with the bearer token stored in `AI_WEBSOCKET_AUTH_TOKEN_FILE`. A token value must never be placed in an
environment variable, image, repository, command output, or log.

Important configuration includes `AI_MODEL_CACHE_DIR`, `AI_MODEL_MANIFEST`, `AI_DEVICE`,
`AI_ALLOW_CPU_FALLBACK`, `AI_EXPECTED_CUDA_CAPABILITY`, `AI_EXPECTED_CUDA_DEVICE_NAME`,
`AI_MICROBATCH_SIZE`, `AI_MAX_SERIES`, `AI_MAX_EVALUATION_ORIGINS`, `AI_MIN_CONTEXT_BARS`,
`AI_MAX_CONTEXT_BARS`, `AI_KRONOS_SAMPLE_COUNT`, `AI_MAX_REQUEST_BYTES`, `AI_MAX_RESPONSE_BYTES`, and the
`AI_WEBSOCKET_*` transport limits.

## Worker-local raw artifacts

`raw-generate` is an offline FinCast or Chronos-2 path selected by `AI_MODEL_LANE`. It does not start the service,
serialize OHLCV JSON, or open a WebSocket. The live request/response contract and FinCast live backend remain
unchanged.

The input directory uses `fincast-raw-input/v1`: a bounded `manifest.json`, little-endian FP32
`contexts.f32` shaped `[rows,512]`, and ordered `origins.jsonl` containing non-price metadata. The output directory
uses `fincast-raw-predictions/v1`. Each atomically committed chunk stores FP32 mean plus native q10 through q90 at
5, 15, 30, and 60 minutes, row bounds, input/output digests, backend/batch identity, routing policy, fixed model and
source provenance, latency, and GPU telemetry.

Routing uses `fincast-row-routing-uniform/v1`, derived from the model seed, row ID, decode pass, layer, route, and
token. It is independent of process-global RNG, batch size, resume boundary, CUDA Graph replay, and challenger
precision. Resume validates every completed chunk and only advances over one contiguous verified prefix. Input,
output, and benchmark paths must be absolute, normalized, and free of symlink traversal.

The retained FinCast FP32 backends are `eager`, `no_padding`, `batched_experts`, and `cuda_graph`. TensorRT
containers, engines, plugins, and build output were operator-deleted and are not rebuilt implicitly; both FP32 and
INT8 TensorRT routes are unavailable.
The P40 qualification run `fincast-p40-opt-20260727-190032` selected `cuda_graph` with batch 48 for 15, 30, and
60-second inputs. These defaults apply only to `raw-generate`; the live WebSocket backend is unchanged. Environment
variables `AI_FINCAST_RAW_BACKEND` and `AI_FINCAST_RAW_BATCH_{15,30,60}` remain explicit offline overrides.

Chronos-2 input uses `chronos2-raw-input/v1`: FP32 contexts `[rows,variates,512]`, explicit uint8 masks, FP32
known-future buffers `[rows,variates,64]`, and ordered origins. Supported ablation profiles are `close_only`,
`ohlcv_calendar`, `microstructure_calendar`, and `derivatives_calendar`. Calendar values are the only known-future
covariates. Trade count and taker-buy shares come from finalized Binance klines; mark/index/premium history and the
latest funding observation at or before each bar close are causal past covariates. Open interest and long/short
statistics are excluded from the five-week default because Binance exposes insufficient history.

Chronos-2 output uses `chronos2-raw-predictions/v1` with FP32 point q50 plus all native q01, q05, q10...q95, q99
values at 5, 15, 30, and 60 minutes. Its cumulative optimization candidates are `pipeline_eager`, `worker_local`,
`no_padding` (prebuilt 64-step patch alignment), `gpu_gather`, and `cuda_graph`; the last partial graph batch uses the
same optimized eager path. Dense feed-forward blocks make FinCast's packed-MoE optimization not applicable.
The five-week P40 qualification run `chronos2-full-5w-20260727-220258` selected `close_only`, `gpu_gather`, and
variate batch 32. The subsequent P40 exact gate qualified the live adapter's `cuda_graph` backend with exact
output parity against `gpu_gather`; graph capture contains only the static model core, while horizon projection
uses preallocated indices outside capture. `AI_CHRONOS2_INFERENCE_BACKEND=pipeline_eager` remains the explicit
rollback. FinCast and Chronos-2 retain separate lanes and pinned revisions.

## Explicit cache preparation

Run this only on an operator workstation or GPU host where outbound Hugging Face access is intentionally allowed:

```bash
uv run --python 3.12 --with huggingface-hub==0.33.1 \
  python scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache

python3 scripts/prepare-ai-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache \
  --check-only

uv run --python 3.12 --with huggingface-hub \
  python scripts/prepare-chronos2-model-cache.py \
  --cache-dir /absolute/offline/ai-model-cache
```

The script prepares and verifies only the pinned Kronos-base and tokenizer snapshots. The pinned Kronos source tree is
reviewed and provisioned separately under `kronos-source`; runtime validates its revision marker and required files.
The separate Chronos-2 command downloads only the pinned config and safetensors file, verifies the reviewed weight
SHA-256, writes the revision marker atomically, and then makes the snapshot read-only. The cache directory must be
traversable by container UID 10001 and is mounted read-only into the worker.
