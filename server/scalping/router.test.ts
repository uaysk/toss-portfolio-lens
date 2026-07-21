import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createScalpingRouter, parseStreamAnalysisOptions, parseStreamSymbols } from "./router.js";

describe("scalping session-only router", () => {
  it("normalizes and bounds SSE symbols", () => {
    expect(parseStreamSymbols("005930, 000660,005930", 5)).toEqual(["005930", "000660"]);
    expect(() => parseStreamSymbols("", 5)).toThrow("1..5");
    expect(() => parseStreamSymbols("005930,000660", 1)).toThrow("1..1");
    expect(() => parseStreamSymbols("../../secret", 5)).toThrow("valid symbols");
  });

  it("requires an explicit interval and preset for connection-local Rust analysis", () => {
    expect(parseStreamAnalysisOptions({ interval: "15m", preset: "breakout", accountId: "account-1" })).toEqual({
      interval: "15m", preset: "breakout", accountId: "account-1",
    });
    expect(() => parseStreamAnalysisOptions({ preset: "trend" })).toThrow();
    expect(() => parseStreamAnalysisOptions({ interval: "2m", preset: "trend" })).toThrow();
    expect(() => parseStreamAnalysisOptions({ interval: "1m", preset: "all" })).toThrow();
  });

  it("registers only dashboard HTTP routes behind the supplied session middleware", () => {
    const authenticate = vi.fn((_request, _response, next) => next());
    const router = createScalpingRouter({
      authenticate,
      config: { enabled: false, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 250 },
    });
    const source = router.stack.map((layer: { route?: { path?: string } }) => layer.route?.path).filter(Boolean);
    expect(source).toEqual(expect.arrayContaining(["/status", "/workspace", "/forecast", "/evaluations", "/stream"]));
    expect(source.some((path) => String(path).includes("order"))).toBe(false);
    expect(router.stack[0]?.handle).toBe(authenticate);
  });

  it("filters bar intervals and debounces finalized bars into one connection-local analysis batch", async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const release = vi.fn();
    const live = {
      retain: vi.fn().mockResolvedValue(release),
      onEvent: vi.fn((next) => {
        listener = next;
        return vi.fn();
      }),
      eventsAfter: vi.fn().mockReturnValue([]),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const realtimeAnalysis = vi.fn().mockResolvedValue({
      schemaVersion: "scalping-realtime-analysis/v1",
      interval: "5m",
      preset: "trend",
      technical: { status: "available" },
    });
    const router = createScalpingRouter({
      authenticate: vi.fn((_request, _response, next) => next()),
      service: { realtimeAnalysis } as never,
      live: live as never,
      config: { enabled: true, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 50 },
    });
    const route = router.stack.find((layer: { route?: { path?: string } }) => layer.route?.path === "/stream") as any;
    const handler = route.route.stack.at(-1).handle as (request: unknown, response: unknown) => Promise<void>;
    const request = new EventEmitter() as EventEmitter & Record<string, any>;
    request.query = { symbols: "005930,000660", interval: "5m", preset: "trend" };
    request.get = vi.fn().mockReturnValue(undefined);
    const writes: string[] = [];
    const response = new EventEmitter() as EventEmitter & Record<string, any>;
    response.status = vi.fn().mockReturnValue(response);
    response.setHeader = vi.fn();
    response.flushHeaders = vi.fn();
    response.write = vi.fn((value: string) => {
      writes.push(value);
      return true;
    });
    response.end = vi.fn();
    await handler(request, response);
    const event = (id: number, symbol: string, intervalMinutes: number, state: "forming" | "final") => ({
      schemaVersion: "scalping-live-event/v1",
      id,
      emittedAt: "2026-07-21T03:00:00.000Z",
      type: "bar",
      symbol,
      payload: { intervalMinutes, state },
    });
    listener!(event(1, "005930", 1, "final"));
    listener!(event(2, "005930", 5, "forming"));
    listener!(event(3, "005930", 5, "final"));
    listener!(event(4, "000660", 5, "final"));
    await vi.waitFor(() => expect(realtimeAnalysis).toHaveBeenCalledTimes(1));
    expect(live.waitForIdle).toHaveBeenCalledTimes(1);
    expect(realtimeAnalysis).toHaveBeenCalledWith({
      symbols: ["005930", "000660"], interval: "5m", preset: "trend",
    });
    expect(writes.join("\n")).not.toContain('"intervalMinutes":1');
    expect(writes.join("\n")).toContain("event: analysis");
    request.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is mounted separately from MCP and generic tool execution", () => {
    const server = readFileSync("server/index.ts", "utf8");
    const schemas = readFileSync("server/mcp/schemas.ts", "utf8");
    const docs = readFileSync("docs/mcp-chatgpt.md", "utf8");
    expect(server).toContain('app.use("/api/portfolio/scalping", createScalpingRouter');
    expect(server).not.toContain('app.post("/api/portfolio/tools/scalping');
    expect(schemas).not.toMatch(/scalping|단타/i);
    expect(docs).not.toMatch(/scalping|단타/i);
  });
});
