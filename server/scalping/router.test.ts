import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createScalpingRouter,
  parseStreamAnalysisOptions,
  parseStreamExchanges,
  parseStreamSymbols,
} from "./router.js";

describe("scalping session-only router", () => {
  it("normalizes and bounds SSE symbols", () => {
    expect(parseStreamSymbols("005930, 000660,005930", 5)).toEqual(["005930", "000660"]);
    expect(() => parseStreamSymbols("", 5)).toThrow("1..5");
    expect(() => parseStreamSymbols("005930,000660", 1)).toThrow("1..1");
    expect(() => parseStreamSymbols("../../secret", 5)).toThrow("valid symbols");
  });

  it("requires an explicit interval and preset for connection-local Rust analysis", () => {
    expect(parseStreamAnalysisOptions({ interval: "15m", preset: "breakout", accountId: "account-1" })).toEqual({
      marketCountry: "KR", interval: "15m", preset: "breakout", accountId: "account-1",
    });
    expect(parseStreamAnalysisOptions({ marketCountry: "US", interval: "5m", preset: "trend" })).toMatchObject({
      marketCountry: "US", interval: "5m", preset: "trend",
    });
    expect(() => parseStreamAnalysisOptions({ preset: "trend" })).toThrow();
    expect(() => parseStreamAnalysisOptions({ interval: "2m", preset: "trend" })).toThrow();
    expect(() => parseStreamAnalysisOptions({ interval: "1m", preset: "all" })).toThrow();
  });

  it("accepts only explicit US exchange mappings and leaves unmapped symbols unavailable", () => {
    expect(parseStreamExchanges("AAPL:NAS,IBM:NYS", ["AAPL", "IBM"], "US")).toEqual({
      AAPL: "NAS", IBM: "NYS",
    });
    expect(parseStreamExchanges("AAPL:NAS", ["AAPL", "IBM"], "US")).toEqual({ AAPL: "NAS" });
    expect(parseStreamExchanges(undefined, ["AAPL"], "US")).toEqual({});
    expect(() => parseStreamExchanges("AAPL:NAS,AAPL:NYS", ["AAPL"], "US")).toThrow("conflicting");
    expect(() => parseStreamExchanges("AAPL:NAS", ["AAPL"], "KR")).toThrow("only valid for US");
  });

  it("registers only dashboard HTTP routes behind the supplied session middleware", () => {
    const authenticate = vi.fn((_request, _response, next) => next());
    const router = createScalpingRouter({
      authenticate,
      config: { enabled: false, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 250, backpressureEventLimit: 100 },
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
      config: { enabled: true, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 50, backpressureEventLimit: 100 },
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
    const event = (
      id: number,
      symbol: string,
      intervalMinutes: number,
      state: "forming" | "final",
      marketCountry: "KR" | "US" = "KR",
    ) => ({
      schemaVersion: "scalping-live-event/v1",
      id,
      emittedAt: "2026-07-21T03:00:00.000Z",
      type: "bar",
      symbol,
      marketCountry,
      payload: { intervalMinutes, state },
    });
    listener!(event(1, "005930", 1, "final"));
    listener!(event(2, "005930", 5, "forming"));
    listener!(event(3, "005930", 5, "final"));
    listener!(event(4, "000660", 5, "final"));
    listener!(event(5, "005930", 5, "final", "US"));
    await vi.waitFor(() => expect(realtimeAnalysis).toHaveBeenCalledTimes(1));
    expect(live.waitForIdle).toHaveBeenCalledTimes(1);
    expect(live.waitForIdle.mock.invocationCallOrder[0])
      .toBeLessThan(realtimeAnalysis.mock.invocationCallOrder[0]!);
    expect(realtimeAnalysis).toHaveBeenCalledWith({
      symbols: ["005930", "000660"], marketCountry: "KR", interval: "5m", preset: "trend",
    });
    expect(live.retain).toHaveBeenCalledWith(["005930", "000660"], "KR", {});
    expect(live.eventsAfter).not.toHaveBeenCalled();
    expect(writes.join("\n")).not.toContain('"intervalMinutes":1');
    expect(writes.join("\n")).not.toContain('"id":5');
    expect(writes.join("\n")).toContain('"marketCountry":"KR"');
    expect(writes.join("\n")).toContain("event: analysis");
    request.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips stale replay for a fresh SSE connection and causally replays an explicit cursor", async () => {
    let listener: ((event: Record<string, any>) => void) | undefined;
    const stale = {
      schemaVersion: "scalping-live-event/v1", id: 7, emittedAt: "2026-07-21T06:00:00.000Z",
      type: "trade", symbol: "005930", marketCountry: "KR",
      payload: { provider: "kis", symbol: "005930", market: "NXT", price: 100 },
    };
    const replayEight = { ...stale, id: 8, payload: { ...stale.payload, price: 101 } };
    const replayNine = { ...stale, id: 9, payload: { ...stale.payload, price: 102 } };
    const liveTen = { ...stale, id: 10, emittedAt: "2026-07-21T06:00:01.000Z", payload: { ...stale.payload, price: 103 } };
    const eventsAfter = vi.fn(() => {
      listener?.(liveTen);
      return [replayNine, replayEight];
    });
    const live = {
      retain: vi.fn().mockResolvedValue(vi.fn()),
      onEvent: vi.fn((next) => { listener = next; return vi.fn(); }),
      eventsAfter,
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const router = createScalpingRouter({
      authenticate: vi.fn((_request, _response, next) => next()),
      service: { realtimeAnalysis: vi.fn() } as never,
      live: live as never,
      config: { enabled: true, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 50, backpressureEventLimit: 100 },
    });
    const route = router.stack.find((layer: { route?: { path?: string } }) => layer.route?.path === "/stream") as any;
    const handler = route.route.stack.at(-1).handle as (request: unknown, response: unknown) => Promise<void>;
    const invoke = async (cursor?: string) => {
      const request = new EventEmitter() as EventEmitter & Record<string, any>;
      request.query = { symbols: "005930", interval: "1m", preset: "trend" };
      request.get = vi.fn((name: string) => name === "last-event-id" ? cursor : undefined);
      const writes: string[] = [];
      const response = new EventEmitter() as EventEmitter & Record<string, any>;
      response.status = vi.fn().mockReturnValue(response);
      response.setHeader = vi.fn();
      response.flushHeaders = vi.fn();
      response.write = vi.fn((value: string) => { writes.push(value); return true; });
      response.end = vi.fn();
      await handler(request, response);
      return { request, writes };
    };

    const fresh = await invoke();
    expect(eventsAfter).not.toHaveBeenCalled();
    expect(fresh.writes.join("\n")).not.toContain('"id":7');
    fresh.request.emit("close");

    const resumed = await invoke("7");
    expect(eventsAfter).toHaveBeenCalledWith(7);
    const output = resumed.writes.join("\n");
    expect(output.indexOf('"id":8')).toBeLessThan(output.indexOf('"id":9'));
    expect(output.indexOf('"id":9')).toBeLessThan(output.indexOf('"id":10'));
    expect(output).toContain('"market":"NXT"');
    expect(output).toContain('"marketCountry":"KR"');
    resumed.request.emit("close");
  });

  it("preserves every explicit replay event across SSE backpressure before coalesced live updates", async () => {
    let listener: ((event: Record<string, any>) => void) | undefined;
    const event = (id: number) => ({
      schemaVersion: "scalping-live-event/v1", id, emittedAt: "2026-07-21T06:00:00.000Z",
      type: "trade", symbol: "005930", marketCountry: "KR",
      payload: { provider: "kis", symbol: "005930", market: "NXT", price: 100 + id },
    });
    const live = {
      retain: vi.fn().mockResolvedValue(vi.fn()),
      onEvent: vi.fn((next) => { listener = next; return vi.fn(); }),
      eventsAfter: vi.fn(() => {
        listener?.(event(11));
        listener?.(event(12));
        return [event(8), event(9), event(10)];
      }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const router = createScalpingRouter({
      authenticate: vi.fn((_request, _response, next) => next()),
      service: { realtimeAnalysis: vi.fn() } as never,
      live: live as never,
      config: { enabled: true, maximumSymbols: 50, heartbeatMs: 15_000, analysisDebounceMs: 50, backpressureEventLimit: 100 },
    });
    const route = router.stack.find((layer: { route?: { path?: string } }) => layer.route?.path === "/stream") as any;
    const handler = route.route.stack.at(-1).handle as (request: unknown, response: unknown) => Promise<void>;
    const request = new EventEmitter() as EventEmitter & Record<string, any>;
    request.query = { symbols: "005930", interval: "1m", preset: "trend" };
    request.get = vi.fn((name: string) => name === "last-event-id" ? "7" : undefined);
    const writes: string[] = [];
    let first = true;
    const response = new EventEmitter() as EventEmitter & Record<string, any>;
    response.status = vi.fn().mockReturnValue(response);
    response.setHeader = vi.fn();
    response.flushHeaders = vi.fn();
    response.write = vi.fn((value: string) => {
      writes.push(value);
      if (first) {
        first = false;
        return false;
      }
      return true;
    });
    response.end = vi.fn();

    await handler(request, response);
    expect(writes.join("\n")).toContain('"id":8');
    expect(writes.join("\n")).not.toContain('"id":9');
    response.emit("drain");
    const output = writes.join("\n");
    const positions = [8, 9, 10, 11, 12].map((id) => output.indexOf(`"id":${id}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    request.emit("close");
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
