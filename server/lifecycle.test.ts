import express from "express";
import { EventEmitter } from "node:events";
import {
  createServer,
  get,
  type IncomingMessage,
  type Server,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GracefulLifecycle,
  ShutdownGate,
  SseConnectionBusyError,
  SseConnectionTracker,
} from "./lifecycle.js";
import { createScalpingRouter } from "./scalping/router.js";

const servers: Server[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

function open(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, resolve);
    request.once("error", reject);
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function trackedResponse() {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    end: vi.fn(),
  });
  return response;
}

describe("SSE connection tracker", () => {
  it("atomically bounds admissions and releases slots on disconnect and unregister", () => {
    const tracker = new SseConnectionTracker({ maximumConnections: 1 });
    const first = trackedResponse();
    const firstCleanup = vi.fn();
    tracker.track(first as never, firstCleanup);

    expect(tracker.telemetry).toEqual({
      capacity: 1,
      activeConnections: 1,
      acceptedConnectionsTotal: 1,
      rejectedConnectionsTotal: 0,
      closing: false,
    });

    const rejected = trackedResponse();
    const rejectedCleanup = vi.fn();
    expect(() => tracker.track(rejected as never, rejectedCleanup))
      .toThrow(SseConnectionBusyError);
    expect(rejected.listenerCount("close")).toBe(0);
    expect(rejectedCleanup).not.toHaveBeenCalled();
    expect(tracker.telemetry.rejectedConnectionsTotal).toBe(1);

    first.destroyed = true;
    first.emit("close");
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(0);

    const disconnected = trackedResponse();
    disconnected.destroyed = true;
    const disconnectedCleanup = vi.fn();
    const disconnectedUnregister = tracker.track(
      disconnected as never,
      disconnectedCleanup,
    );
    disconnectedUnregister();
    expect(disconnectedCleanup).toHaveBeenCalledTimes(1);
    expect(disconnected.end).not.toHaveBeenCalled();
    expect(tracker.telemetry.acceptedConnectionsTotal).toBe(1);

    const next = trackedResponse();
    const nextCleanup = vi.fn();
    const unregister = tracker.track(next as never, nextCleanup);
    expect(tracker.telemetry.acceptedConnectionsTotal).toBe(2);
    unregister();
    unregister();
    expect(nextCleanup).not.toHaveBeenCalled();
    expect(tracker.size).toBe(0);
  });

  it("closes admitted streams once and reports shutdown state", () => {
    const tracker = new SseConnectionTracker({ maximumConnections: 1 });
    const response = trackedResponse();
    const cleanup = vi.fn();
    tracker.track(response as never, cleanup);

    tracker.closeAll();
    tracker.closeAll();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(tracker.telemetry).toMatchObject({
      capacity: 1,
      activeConnections: 0,
      acceptedConnectionsTotal: 1,
      rejectedConnectionsTotal: 0,
      closing: true,
    });

    const lateResponse = trackedResponse();
    const lateCleanup = vi.fn();
    expect(() => tracker.track(lateResponse as never, lateCleanup))
      .toThrow(SseConnectionBusyError);
    expect(lateCleanup).not.toHaveBeenCalled();
    expect(lateResponse.end).not.toHaveBeenCalled();
    expect(tracker.telemetry.rejectedConnectionsTotal).toBe(1);
  });
});

describe("graceful server lifecycle", () => {
  it("disposes constructor and signal listeners after pre-start assembly failure", () => {
    const server = createServer();
    const connectionListeners = server.listenerCount("connection");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const sigintListeners = process.listenerCount("SIGINT");
    const lifecycle = new GracefulLifecycle({
      server,
      gate: new ShutdownGate(),
      sseConnections: new SseConnectionTracker(),
      deadlineMs: 500,
    });

    try {
      expect(server.listenerCount("connection")).toBe(connectionListeners + 1);
      lifecycle.installSignalHandlers();
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);

      lifecycle.dispose();
      lifecycle.dispose();

      expect(server.listenerCount("connection")).toBe(connectionListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    } finally {
      lifecycle.dispose();
    }
  });

  it("ends an active scalping SSE stream, releases it and shuts down exactly once", async () => {
    const gate = new ShutdownGate();
    const sseConnections = new SseConnectionTracker();
    const release = vi.fn();
    const removeListener = vi.fn();
    const app = express();
    app.use(gate.middleware);
    app.use("/scalping", createScalpingRouter({
      authenticate: (_request, _response, next) => next(),
      service: { realtimeAnalysis: vi.fn() } as never,
      live: {
        retain: vi.fn().mockResolvedValue(release),
        onEvent: vi.fn().mockReturnValue(removeListener),
        eventsAfter: vi.fn().mockReturnValue([]),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      } as never,
      sseConnections,
      config: {
        enabled: true,
        maximumSymbols: 5,
        heartbeatMs: 1_000,
        analysisDebounceMs: 50,
        backpressureEventLimit: 100,
      },
    }));
    const server = createServer(app);
    const onShutdownStart = vi.fn().mockResolvedValue(undefined);
    const onDrained = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const lifecycle = new GracefulLifecycle({
      server,
      gate,
      sseConnections,
      deadlineMs: 500,
      onShutdownStart,
      onDrained,
      exit,
    });
    const baseUrl = await listen(server);
    const response = await open(
      `${baseUrl}/scalping/stream?symbols=005930&interval=1m&preset=trend`,
    );
    response.resume();
    const ended = new Promise<void>((resolve) => {
      response.once("end", resolve);
      response.once("close", resolve);
    });
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(sseConnections.size).toBe(1);

    const first = lifecycle.shutdown("SIGTERM");
    const second = lifecycle.shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    await ended;

    expect(release).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(sseConnections.size).toBe(0);
    expect(onShutdownStart).toHaveBeenCalledTimes(1);
    expect(onShutdownStart).toHaveBeenCalledWith("SIGTERM");
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(gate.active).toBe(true);
    expect(server.listening).toBe(false);
  });

  it("forces remaining HTTP sockets after the configured deadline", async () => {
    const gate = new ShutdownGate();
    const sseConnections = new SseConnectionTracker();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
    });
    const warn = vi.fn();
    const exit = vi.fn();
    const onDrained = vi.fn().mockResolvedValue(undefined);
    const closeAllConnections = vi.spyOn(server, "closeAllConnections");
    const lifecycle = new GracefulLifecycle({
      server,
      gate,
      sseConnections,
      deadlineMs: 25,
      onShutdownStart: vi.fn().mockResolvedValue(undefined),
      onDrained,
      exit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const baseUrl = await listen(server);
    const response = await open(`${baseUrl}/hang`);
    response.on("error", () => undefined);
    response.on("aborted", () => undefined);
    response.resume();

    await Promise.race([
      lifecycle.shutdown("SIGTERM"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not finish")), 500)),
    ]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("drain budget exceeded"));
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(closeAllConnections.mock.invocationCallOrder[0])
      .toBeLessThan(onDrained.mock.invocationCallOrder[0]!);
    expect(onDrained.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.listening).toBe(false);
  });

  it("does not close persistent resources while application drain is still running", async () => {
    const gate = new ShutdownGate();
    const sseConnections = new SseConnectionTracker();
    const server = createServer();
    const warn = vi.fn();
    const exit = vi.fn();
    const onDrained = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new GracefulLifecycle({
      server,
      gate,
      sseConnections,
      deadlineMs: 25,
      onShutdownStart: vi.fn(() => new Promise<void>(() => undefined)),
      onDrained,
      exit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    await Promise.race([
      lifecycle.shutdown("SIGTERM"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not finish")), 500)),
    ]);

    expect(onDrained).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping final resource close"),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("waits for an active HTTP handler before closing application storage", async () => {
    const gate = new ShutdownGate();
    const sseConnections = new SseConnectionTracker();
    const handlerEntered = deferred();
    const releaseHandler = deferred();
    const server = createServer(async (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
      handlerEntered.resolve();
      await releaseHandler.promise;
      response.end("complete");
    });
    const onDrained = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const exit = vi.fn();
    const lifecycle = new GracefulLifecycle({
      server,
      gate,
      sseConnections,
      deadlineMs: 500,
      onShutdownStart: vi.fn().mockResolvedValue(undefined),
      onDrained,
      exit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const baseUrl = await listen(server);
    const response = await open(`${baseUrl}/active`);
    response.resume();
    await handlerEntered.promise;

    const shutdown = lifecycle.shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onDrained).not.toHaveBeenCalled();

    releaseHandler.resolve();
    await shutdown;
    expect(warn).not.toHaveBeenCalled();
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    expect(server.listening).toBe(false);
  });

  it("does not wait indefinitely when final storage cleanup stalls", async () => {
    const gate = new ShutdownGate();
    const sseConnections = new SseConnectionTracker();
    const server = createServer();
    const warn = vi.fn();
    const exit = vi.fn();
    const lifecycle = new GracefulLifecycle({
      server,
      gate,
      sseConnections,
      deadlineMs: 25,
      onShutdownStart: vi.fn().mockResolvedValue(undefined),
      onDrained: vi.fn(() => new Promise<void>(() => undefined)),
      exit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    await Promise.race([
      lifecycle.shutdown("SIGTERM"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not finish")), 500)),
    ]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("final cleanup did not complete"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("rejects requests after shutdown begins", () => {
    const gate = new ShutdownGate();
    const next = vi.fn();
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);

    gate.middleware({} as never, response as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    gate.beginShutdown();
    gate.middleware({} as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "server-shutting-down",
        message: "서버가 종료 중입니다. 잠시 후 다시 시도해 주세요.",
      },
    });
  });
});
