import { describe, expect, it } from "vitest";
import type { AiComputeClientSnapshot } from "../worker/ai-client.js";
import { cryptoWorkerPublicState } from "./worker-public-state.js";

function snapshot(
  connection: AiComputeClientSnapshot["connection"],
  input: {
    status?: "available" | "degraded" | "unavailable";
    precision?: "float32" | "mixed_float16";
    memoryStatus?: "ok" | "memory_pressure";
  } = {},
): AiComputeClientSnapshot {
  return {
    connection,
    transportVersion: "scalping-ai-ws/v1",
    secure: false,
    pendingRequests: 0,
    worker: {
      status: input.status ?? "available",
      generated_at: "2026-07-25T00:00:00.000Z",
      model: {
        loaded: input.memoryStatus !== "memory_pressure",
        model_id: "NeoQuasar/Kronos-base",
        model_revision: "revision",
        device: input.memoryStatus === "memory_pressure" ? "unavailable" : "cuda",
        precision: input.precision ?? "float32",
        memory_status: input.memoryStatus ?? "ok",
      },
      active_requests: 0,
      queued_requests: 0,
    },
  };
}

describe("cryptoWorkerPublicState", () => {
  it("does not report a cached worker payload as healthy after disconnect", () => {
    expect(cryptoWorkerPublicState(snapshot("reconnecting"))).toEqual({
      status: "unavailable",
      precision: "fp32",
    });
  });

  it("reports connected precision and memory pressure without private detail", () => {
    expect(cryptoWorkerPublicState(snapshot("connected", {
      precision: "mixed_float16",
      memoryStatus: "memory_pressure",
    }))).toEqual({
      status: "memory_pressure",
      precision: "fp16",
    });
  });
});
