from __future__ import annotations

import ctypes
from dataclasses import dataclass
import statistics
import threading
import time
from typing import Any


class GpuTelemetryError(RuntimeError):
    pass


class _NvmlMemory(ctypes.Structure):
    _fields_ = [
        ("total", ctypes.c_ulonglong),
        ("free", ctypes.c_ulonglong),
        ("used", ctypes.c_ulonglong),
    ]


class _NvmlUtilization(ctypes.Structure):
    _fields_ = [
        ("gpu", ctypes.c_uint),
        ("memory", ctypes.c_uint),
    ]


@dataclass(frozen=True, slots=True)
class GpuSnapshot:
    sampled_at_monotonic: float
    memory_total_bytes: int
    memory_free_bytes: int
    memory_used_bytes: int
    gpu_utilization_percent: int
    memory_utilization_percent: int
    power_watts: float
    temperature_celsius: int

    def json(self) -> dict[str, int | float]:
        return {
            "memory_total_bytes": self.memory_total_bytes,
            "memory_free_bytes": self.memory_free_bytes,
            "memory_used_bytes": self.memory_used_bytes,
            "gpu_utilization_percent": self.gpu_utilization_percent,
            "memory_utilization_percent": self.memory_utilization_percent,
            "power_watts": self.power_watts,
            "temperature_celsius": self.temperature_celsius,
        }


class NvmlDevice:
    def __init__(self, device_index: int) -> None:
        try:
            self._nvml = ctypes.CDLL("libnvidia-ml.so.1")
        except OSError as error:
            raise GpuTelemetryError("NVML library is unavailable") from error
        init = getattr(self._nvml, "nvmlInit_v2", None) or getattr(
            self._nvml,
            "nvmlInit",
            None,
        )
        get_handle = getattr(self._nvml, "nvmlDeviceGetHandleByIndex_v2", None) or getattr(
            self._nvml,
            "nvmlDeviceGetHandleByIndex",
            None,
        )
        if init is None or get_handle is None:
            raise GpuTelemetryError("NVML initialization functions are unavailable")
        self._shutdown = getattr(self._nvml, "nvmlShutdown", None)
        if self._shutdown is None or init() != 0:
            raise GpuTelemetryError("NVML initialization failed")
        self._handle = ctypes.c_void_p()
        if get_handle(ctypes.c_uint(device_index), ctypes.byref(self._handle)) != 0:
            self.close()
            raise GpuTelemetryError("NVML could not resolve the configured GPU")

    def close(self) -> None:
        if self._shutdown is not None:
            self._shutdown()
            self._shutdown = None

    def __enter__(self) -> NvmlDevice:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def snapshot(self) -> GpuSnapshot:
        memory = _NvmlMemory()
        utilization = _NvmlUtilization()
        power_milliwatts = ctypes.c_uint()
        temperature = ctypes.c_uint()
        calls = (
            (
                "nvmlDeviceGetMemoryInfo",
                (self._handle, ctypes.byref(memory)),
            ),
            (
                "nvmlDeviceGetUtilizationRates",
                (self._handle, ctypes.byref(utilization)),
            ),
            (
                "nvmlDeviceGetPowerUsage",
                (self._handle, ctypes.byref(power_milliwatts)),
            ),
            (
                "nvmlDeviceGetTemperature",
                (self._handle, ctypes.c_uint(0), ctypes.byref(temperature)),
            ),
        )
        for name, arguments in calls:
            function = getattr(self._nvml, name, None)
            if function is None or function(*arguments) != 0:
                raise GpuTelemetryError(f"NVML call failed: {name}")
        return GpuSnapshot(
            sampled_at_monotonic=time.monotonic(),
            memory_total_bytes=int(memory.total),
            memory_free_bytes=int(memory.free),
            memory_used_bytes=int(memory.used),
            gpu_utilization_percent=int(utilization.gpu),
            memory_utilization_percent=int(utilization.memory),
            power_watts=float(power_milliwatts.value) / 1_000,
            temperature_celsius=int(temperature.value),
        )


class GpuTelemetrySampler:
    def __init__(self, device_index: int, *, interval_seconds: float = 0.05) -> None:
        if interval_seconds <= 0 or interval_seconds > 5:
            raise ValueError("GPU telemetry interval must be between zero and five seconds")
        self.device_index = device_index
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._samples: list[GpuSnapshot] = []
        self._error: str | None = None

    def __enter__(self) -> GpuTelemetrySampler:
        self._thread = threading.Thread(
            target=self._sample,
            name="fincast-raw-nvml",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self.interval_seconds * 4))

    def _sample(self) -> None:
        try:
            with NvmlDevice(self.device_index) as device:
                while not self._stop.is_set():
                    self._samples.append(device.snapshot())
                    self._stop.wait(self.interval_seconds)
                self._samples.append(device.snapshot())
        except Exception as error:
            self._error = f"{type(error).__name__}: {error}"[:300]

    def summary(self) -> dict[str, Any]:
        if not self._samples:
            return {
                "status": "unavailable",
                "reason": self._error or "no GPU telemetry samples were collected",
                "sample_count": 0,
            }
        samples = self._samples
        return {
            "status": "available",
            "sample_count": len(samples),
            "duration_ms": max(
                0.0,
                (samples[-1].sampled_at_monotonic - samples[0].sampled_at_monotonic)
                * 1_000,
            ),
            "memory_total_bytes": samples[-1].memory_total_bytes,
            "min_memory_free_bytes": min(item.memory_free_bytes for item in samples),
            "max_memory_used_bytes": max(item.memory_used_bytes for item in samples),
            "gpu_utilization_percent": {
                "mean": statistics.fmean(item.gpu_utilization_percent for item in samples),
                "max": max(item.gpu_utilization_percent for item in samples),
            },
            "memory_utilization_percent": {
                "mean": statistics.fmean(item.memory_utilization_percent for item in samples),
                "max": max(item.memory_utilization_percent for item in samples),
            },
            "power_watts": {
                "mean": statistics.fmean(item.power_watts for item in samples),
                "max": max(item.power_watts for item in samples),
            },
            "temperature_celsius": {
                "mean": statistics.fmean(item.temperature_celsius for item in samples),
                "max": max(item.temperature_celsius for item in samples),
            },
            **({"warning": self._error} if self._error else {}),
        }
