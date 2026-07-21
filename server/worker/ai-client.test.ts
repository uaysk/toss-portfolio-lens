import type net from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { AiComputeClient } from "./ai-client.js";
import { aiRequestBase, type AiRequest } from "./ai-contract.js";

const BAR_TIME = "2026-07-21T00:00:00.000Z";

function request(): AiRequest {
  return {
    ...aiRequestBase("request-1"),
    mode: "forecast",
    series: [{
      instrument_key: "005930",
      timezone: "Asia/Seoul",
      input_end_at: BAR_TIME,
      bars: [{ timestamp: BAR_TIME, open: 100, high: 101, low: 99, close: 100, complete: true }],
      future_timestamps: Array.from({ length: 60 }, (_, index) => (
        new Date(Date.parse(BAR_TIME) + (index + 1) * 60_000).toISOString()
      )),
    }],
  };
}

function unavailableResponse(requestId = "request-1") {
  return {
    schema_version: "scalping-ai/v1",
    request_id: requestId,
    mode: "forecast",
    status: "unavailable",
    model: {
      model_id: "NeoQuasar/Kronos-small",
      model_revision: "pinned",
      source_revision: "source-pinned",
      loader_version: "portfolio-ai-loader/v1",
      license: "MIT",
      device: "unavailable",
      dtype: "float32",
      attention_backend: "unavailable",
      loaded: false,
      fallback_reason: "model cache missing",
    },
    generated_at: "2026-07-21T00:00:01.000Z",
    series: [{
      instrument_key: "005930",
      status: "unavailable",
      input_end_at: BAR_TIME,
      horizons: [],
      input_quality: {
        status: "partial",
        bar_count: 1,
        missing_volume_ratio: 1,
        missing_amount_ratio: 1,
        irregular_interval_count: 0,
        warnings: ["insufficient history"],
      },
      distribution_shift: { status: "unavailable", reason: "reference_statistics_not_published" },
      unavailable: { code: "model-unavailable", message: "model cache missing" },
    }],
  };
}

describe("AiComputeClient", () => {
  function connection(response: unknown): () => net.Socket {
    return () => {
      let requestBuffer = Buffer.alloc(0);
      const socket = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          requestBuffer = Buffer.concat([requestBuffer, chunk]);
          const length = requestBuffer.length >= 4 ? requestBuffer.readUInt32BE(0) : Number.POSITIVE_INFINITY;
          if (requestBuffer.length >= length + 4) {
            JSON.parse(requestBuffer.subarray(4, length + 4).toString("utf8"));
            const body = Buffer.from(JSON.stringify(response));
            const frame = Buffer.alloc(body.length + 4);
            frame.writeUInt32BE(body.length, 0);
            body.copy(frame, 4);
            queueMicrotask(() => {
              socket.push(frame.subarray(0, 7));
              socket.push(frame.subarray(7));
            });
          }
          callback();
        },
      });
      queueMicrotask(() => socket.emit("connect"));
      return socket as net.Socket;
    };
  }

  it("분할된 UDS frame을 조립하고 unavailable을 임의 예측으로 바꾸지 않는다", async () => {
    const fixture = unavailableResponse();
    const response = await new AiComputeClient(
      { socketPath: "/tmp/ai.sock", timeoutMs: 2_000 },
      { createConnection: connection(fixture) },
    ).request(request());
    expect(response).toEqual(fixture);
    expect(response.series[0]).toMatchObject({ status: "unavailable", horizons: [] });
  });

  it("request identity가 다른 응답을 거부한다", async () => {
    await expect(new AiComputeClient(
      { socketPath: "/tmp/ai.sock", timeoutMs: 2_000 },
      { createConnection: connection(unavailableResponse("other-request")) },
    ).request(request())).rejects.toThrow("identity");
  });

  it("forming bar를 AI 입력 계약에서 거부한다", () => {
    const invalid = structuredClone(request()) as unknown as { series: Array<{ bars: Array<{ complete: boolean }> }> };
    invalid.series[0]!.bars[0]!.complete = false;
    expect(() => new AiComputeClient({ socketPath: "/tmp/missing.sock", timeoutMs: 100 }).request(invalid as never))
      .toThrow();
  });

  it("Node와 worker가 공유하는 frame 상한 범위를 검증한다", () => {
    expect(() => new AiComputeClient({
      socketPath: "/tmp/ai.sock", timeoutMs: 100, maximumResponseBytes: 512,
    })).toThrow("AI compute 응답 상한");
    expect(() => new AiComputeClient({
      socketPath: "/tmp/ai.sock", timeoutMs: 100, maximumRequestBytes: 512 * 1024 * 1024 + 1,
    })).toThrow("AI compute 요청 상한");
  });
});
