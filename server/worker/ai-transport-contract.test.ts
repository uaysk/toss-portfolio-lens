import { describe, expect, it } from "vitest";
import { aiRequestBase } from "./ai-contract.js";
import {
  AiClientTransportEnvelopeSchema,
  AiServerTransportEnvelopeSchema,
  SCALPING_AI_TRANSPORT_VERSION,
  SCALPING_AI_WEBSOCKET_PATH,
  SCALPING_AI_WEBSOCKET_SUBPROTOCOL,
} from "./ai-transport-contract.js";

const BAR_TIME = "2026-07-21T00:00:00.000Z";

function request() {
  return {
    ...aiRequestBase("transport-1"),
    mode: "forecast" as const,
    series: [{
      instrument_key: "005930",
      timezone: "Asia/Seoul",
      input_end_at: BAR_TIME,
      bars: [{ timestamp: BAR_TIME, open: 100, high: 101, low: 99, close: 100, complete: true as const }],
      future_timestamps: Array.from({ length: 60 }, (_, index) => (
        new Date(Date.parse(BAR_TIME) + (index + 1) * 60_000).toISOString()
      )),
    }],
  };
}

describe("scalping AI WebSocket transport contract", () => {
  it("버전, path와 subprotocol을 고정한다", () => {
    expect(SCALPING_AI_TRANSPORT_VERSION).toBe("scalping-ai-ws/v1");
    expect(SCALPING_AI_WEBSOCKET_PATH).toBe("/ws/scalping-ai/v1");
    expect(SCALPING_AI_WEBSOCKET_SUBPROTOCOL).toBe("scalping-ai-ws.v1");
  });

  it("request payload와 envelope identity가 일치해야 한다", () => {
    expect(AiClientTransportEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "request",
      request_id: "transport-1",
      payload: request(),
    })).toMatchObject({ type: "request", request_id: "transport-1" });
    expect(() => AiClientTransportEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "request",
      request_id: "other-request",
      payload: request(),
    })).toThrow();
  });

  it("cancel, status와 status_response에 임의 필드를 허용하지 않는다", () => {
    expect(AiClientTransportEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "cancel",
      request_id: "transport-1",
    })).toMatchObject({ type: "cancel" });
    expect(() => AiClientTransportEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "status",
      request_id: "status-1",
      token: "must-not-cross-the-wire",
    })).toThrow();
    expect(AiServerTransportEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "status_response",
      request_id: "status-1",
      status: {
        status: "available",
        model: { loaded: true, device: "cuda", model_id: "kronos-small", model_revision: "pinned" },
        active_requests: 1,
        queued_requests: 0,
        generated_at: "2026-07-21T00:00:01.000Z",
      },
    })).toMatchObject({ type: "status_response", status: { model: { device: "cuda" } } });
  });
});
