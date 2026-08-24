import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SseConnectionTracker } from "../lifecycle.js";
import { admitSseConnection } from "./sse-admission.js";

function mockResponse() {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    end: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  });
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe("SSE admission response", () => {
  it("returns a retryable 503 before SSE headers when shutdown has closed admissions", () => {
    const tracker = new SseConnectionTracker({ maximumConnections: 1 });
    tracker.closeAll();
    const response = mockResponse();
    const cleanup = vi.fn();

    expect(admitSseConnection(tracker, response as never, cleanup)).toBeUndefined();

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(response.setHeader).not.toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream; charset=utf-8",
    );
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "SSE_CONNECTION_BUSY",
        message: "실시간 연결이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
        retryable: true,
      },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
