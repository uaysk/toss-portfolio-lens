from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


@dataclass(frozen=True, slots=True)
class AISettings:
    model_cache_dir: Path
    manifest_path: Path
    device: str
    allow_cpu_fallback: bool
    expected_cuda_capability: str | None
    expected_cuda_device_name: str
    microbatch_size: int
    max_series: int
    max_evaluation_origins: int
    min_context_bars: int
    max_context_bars: int
    sample_count: int
    max_request_bytes: int
    max_response_bytes: int
    model_lane: str = "fincast"
    cross_request_microbatch: bool = False
    kronos_kv_cache_enabled: bool = False
    chronos2_input_profile: str = "compact_causal_v1"
    chronos2_batch_size: int = 32
    chronos2_context_bars: int = 1024
    chronos2_inference_backend: str = "pipeline_eager"
    fincast_context_bars: int = 512
    fincast_min_vram_headroom_bytes: int = 2 * 1024 * 1024 * 1024
    fincast_nvml_device_index: int = 0
    websocket_host: str = "127.0.0.1"
    websocket_port: int = 8765
    websocket_path: str = "/ws/scalping-ai/v1"
    websocket_auth_token_file: Path = Path("/app/ai-auth/token")
    websocket_generate_auth_token: bool = False
    websocket_max_connections: int = 16
    websocket_queue_capacity: int = 16
    websocket_max_in_flight: int = 4
    websocket_ping_interval_seconds: int = 20
    websocket_ping_timeout_seconds: int = 20
    websocket_close_timeout_seconds: int = 10
    websocket_tls_cert_file: Path | None = None
    websocket_tls_key_file: Path | None = None

    @classmethod
    def from_env(cls) -> "AISettings":
        package_root = Path(__file__).resolve().parents[2]
        device = os.getenv("AI_DEVICE", "cuda").strip().lower()
        if device not in {"auto", "cuda", "cpu"}:
            raise ValueError("AI_DEVICE must be auto, cuda, or cpu")
        capability = os.getenv("AI_EXPECTED_CUDA_CAPABILITY", "6.1").strip()
        if capability.lower() == "any" or not capability:
            capability = None
        expected_device_name = os.getenv("AI_EXPECTED_CUDA_DEVICE_NAME", "Tesla P40").strip()
        if not expected_device_name:
            raise ValueError("AI_EXPECTED_CUDA_DEVICE_NAME cannot be empty")
        model_lane = os.getenv("AI_MODEL_LANE", "fincast").strip().lower()
        if model_lane not in {"kronos_base", "fincast", "chronos_2"}:
            raise ValueError("AI_MODEL_LANE must be kronos_base, fincast, or chronos_2")
        return cls(
            model_cache_dir=Path(os.getenv("AI_MODEL_CACHE_DIR", "/models")),
            manifest_path=Path(os.getenv("AI_MODEL_MANIFEST", str(package_root / "model-manifest.json"))),
            device=device,
            allow_cpu_fallback=_boolean("AI_ALLOW_CPU_FALLBACK", False),
            expected_cuda_capability=capability,
            expected_cuda_device_name=expected_device_name,
            microbatch_size=_bounded_int("AI_MICROBATCH_SIZE", 4, 1, 256),
            max_series=_bounded_int("AI_MAX_SERIES", 50, 1, 1_000),
            max_evaluation_origins=_bounded_int("AI_MAX_EVALUATION_ORIGINS", 10_000, 1, 1_000_000),
            min_context_bars=_bounded_int(
                "AI_MIN_CONTEXT_BARS",
                1024 if model_lane == "chronos_2" else 512 if model_lane == "fincast" else 64,
                8,
                8_192,
            ),
            max_context_bars=_bounded_int(
                "AI_MAX_CONTEXT_BARS",
                8192 if model_lane == "chronos_2" else 512,
                8,
                8_192,
            ),
            sample_count=_bounded_int("AI_KRONOS_SAMPLE_COUNT", 20, 2, 256),
            max_request_bytes=_bounded_int("AI_MAX_REQUEST_BYTES", 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
            max_response_bytes=_bounded_int("AI_MAX_RESPONSE_BYTES", 128 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
            model_lane=model_lane,
            cross_request_microbatch=_boolean("AI_CROSS_REQUEST_MICROBATCH", False),
            kronos_kv_cache_enabled=_boolean("AI_KRONOS_KV_CACHE_ENABLED", False),
            chronos2_input_profile=os.getenv(
                "AI_CHRONOS2_INPUT_PROFILE",
                "compact_causal_v1",
            )
            .strip()
            .lower(),
            chronos2_batch_size=_bounded_int("AI_CHRONOS2_BATCH_SIZE", 32, 1, 4_096),
            chronos2_context_bars=_bounded_int(
                "AI_CHRONOS2_CONTEXT_BARS",
                1024,
                512,
                8_192,
            ),
            chronos2_inference_backend=os.getenv(
                "AI_CHRONOS2_INFERENCE_BACKEND",
                "pipeline_eager",
            )
            .strip()
            .lower(),
            fincast_context_bars=_bounded_int("AI_FINCAST_CONTEXT_BARS", 512, 512, 512),
            fincast_min_vram_headroom_bytes=(
                _bounded_int("AI_FINCAST_MIN_VRAM_HEADROOM_MIB", 2_048, 0, 65_536) * 1024 * 1024
            ),
            fincast_nvml_device_index=_bounded_int("AI_FINCAST_NVML_DEVICE_INDEX", 0, 0, 64),
            websocket_host=os.getenv("AI_WEBSOCKET_HOST", "127.0.0.1").strip(),
            websocket_port=_bounded_int("AI_WEBSOCKET_PORT", 8765, 1, 65_535),
            websocket_path=os.getenv("AI_WEBSOCKET_PATH", "/ws/scalping-ai/v1").strip(),
            websocket_auth_token_file=Path(os.getenv("AI_WEBSOCKET_AUTH_TOKEN_FILE", "/app/ai-auth/token")),
            websocket_generate_auth_token=_boolean("AI_WEBSOCKET_GENERATE_AUTH_TOKEN", False),
            websocket_max_connections=_bounded_int("AI_WEBSOCKET_MAX_CONNECTIONS", 16, 1, 1_024),
            websocket_queue_capacity=_bounded_int("AI_WEBSOCKET_QUEUE_CAPACITY", 16, 1, 10_000),
            websocket_max_in_flight=_bounded_int("AI_WEBSOCKET_MAX_IN_FLIGHT", 1, 1, 256),
            websocket_ping_interval_seconds=_bounded_int("AI_WEBSOCKET_PING_INTERVAL_SECONDS", 20, 1, 300),
            websocket_ping_timeout_seconds=_bounded_int("AI_WEBSOCKET_PING_TIMEOUT_SECONDS", 20, 1, 300),
            websocket_close_timeout_seconds=_bounded_int("AI_WEBSOCKET_CLOSE_TIMEOUT_SECONDS", 10, 1, 300),
            websocket_tls_cert_file=(
                Path(value) if (value := os.getenv("AI_WEBSOCKET_TLS_CERT_FILE", "").strip()) else None
            ),
            websocket_tls_key_file=(
                Path(value) if (value := os.getenv("AI_WEBSOCKET_TLS_KEY_FILE", "").strip()) else None
            ),
        ).validate()

    def validate(self) -> "AISettings":
        if self.min_context_bars > self.max_context_bars:
            raise ValueError("AI_MIN_CONTEXT_BARS cannot exceed AI_MAX_CONTEXT_BARS")
        if self.model_lane not in {"kronos_base", "fincast", "chronos_2"}:
            raise ValueError("AI_MODEL_LANE must be kronos_base, fincast, or chronos_2")
        if self.chronos2_input_profile not in {
            "close_only",
            "ohlcv_calendar",
            "microstructure_calendar",
            "derivatives_calendar",
            "compact_causal_v1",
        }:
            raise ValueError(
                "AI_CHRONOS2_INPUT_PROFILE must be close_only, ohlcv_calendar, "
                "microstructure_calendar, derivatives_calendar, or compact_causal_v1"
            )
        if self.model_lane == "fincast" and (
            self.min_context_bars != self.fincast_context_bars or self.max_context_bars != self.fincast_context_bars
        ):
            raise ValueError("FinCast requires AI_MIN/MAX_CONTEXT_BARS=AI_FINCAST_CONTEXT_BARS=512")
        if self.model_lane == "chronos_2" and not (
            self.min_context_bars <= self.chronos2_context_bars <= self.max_context_bars
        ):
            raise ValueError("Chronos-2 default context must be inside AI_MIN/MAX_CONTEXT_BARS")
        if self.chronos2_context_bars not in {512, 1024, 2048, 4096, 8192}:
            raise ValueError("AI_CHRONOS2_CONTEXT_BARS must be a supported Chronos-2 window")
        if self.chronos2_inference_backend not in {
            "pipeline_eager",
            "cuda_graph",
        }:
            raise ValueError("AI_CHRONOS2_INFERENCE_BACKEND must be pipeline_eager or cuda_graph")
        if not self.model_cache_dir.is_absolute():
            raise ValueError("AI model cache path must be absolute")
        if not self.expected_cuda_device_name.strip():
            raise ValueError("AI expected CUDA device name cannot be empty")
        if not self.websocket_host:
            raise ValueError("AI_WEBSOCKET_HOST cannot be empty")
        if self.websocket_path != "/ws/scalping-ai/v1":
            raise ValueError("AI_WEBSOCKET_PATH must be /ws/scalping-ai/v1")
        if not self.websocket_auth_token_file.is_absolute():
            raise ValueError("AI_WEBSOCKET_AUTH_TOKEN_FILE must be absolute")
        if (self.websocket_tls_cert_file is None) != (self.websocket_tls_key_file is None):
            raise ValueError("AI_WEBSOCKET_TLS_CERT_FILE and AI_WEBSOCKET_TLS_KEY_FILE must be set together")
        for path in (self.websocket_tls_cert_file, self.websocket_tls_key_file):
            if path is not None and not path.is_absolute():
                raise ValueError("AI WebSocket TLS paths must be absolute")
        return self
