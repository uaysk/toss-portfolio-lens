import type { AiComputeClientSnapshot } from "../worker/ai-client.js";
import type { CryptoWorkerPublicState } from "./crypto-simulation-service.js";

export function cryptoWorkerPublicState(
  snapshot: AiComputeClientSnapshot | undefined,
): CryptoWorkerPublicState {
  if (!snapshot) return { status: "unavailable", precision: "unknown" };
  const model = snapshot.worker?.model;
  const precision: CryptoWorkerPublicState["precision"] = model?.precision === "mixed_float16"
    ? "fp16"
    : model?.precision === "float32"
      ? "fp32"
      : "unknown";
  // The client retains the last validated worker payload while reconnecting.
  // Only an authenticated, currently connected socket can make that payload
  // authoritative for the public health surface.
  if (snapshot.connection !== "connected") {
    return { status: "unavailable", precision };
  }
  const status: CryptoWorkerPublicState["status"] = model?.memory_status === "memory_pressure"
    ? "memory_pressure"
    : snapshot.worker?.status === "available"
      ? "healthy"
      : snapshot.worker?.status === "degraded"
        ? "degraded"
        : "unavailable";
  return { status, precision };
}
