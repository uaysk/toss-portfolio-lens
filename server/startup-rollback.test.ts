import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { listenForStartup, StartupRollback } from "./startup-rollback.js";

function serverDouble(
  listen: (events: EventEmitter) => void,
): { server: Server; listen: ReturnType<typeof vi.fn> } {
  const events = new EventEmitter();
  const listenMock = vi.fn(() => {
    listen(events);
    return server;
  });
  const server = Object.assign(events, { listen: listenMock }) as unknown as Server;
  return { server, listen: listenMock };
}

describe("StartupRollback", () => {
  it("runs every cleanup in reverse acquisition order despite sync and async failures", async () => {
    const calls: string[] = [];
    const warn = vi.fn();
    const rollback = new StartupRollback({ warn });

    rollback.defer("history storage", () => {
      calls.push("history storage");
    });
    rollback.defer("worker", async () => {
      calls.push("worker");
      throw new Error("worker close failed");
    });
    rollback.defer("timer", () => {
      calls.push("timer");
      throw "timer close failed";
    });

    await rollback.rollback();

    expect(calls).toEqual(["timer", "worker", "history storage"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[startup] rollback timer failed:",
      "unknown error",
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "[startup] rollback worker failed:",
      "worker close failed",
    );
  });

  it("is idempotent and ignores the stack after ownership is committed", async () => {
    const rolledBack = vi.fn();
    const committed = vi.fn();
    const first = new StartupRollback();
    const second = new StartupRollback();
    first.defer("resource", rolledBack);
    second.defer("resource", committed);

    await first.rollback();
    await first.rollback();
    second.commit();
    second.commit();
    await second.rollback();

    expect(rolledBack).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
    expect(() => first.defer("late", vi.fn())).toThrow(/no longer accepting/u);
    expect(() => second.defer("late", vi.fn())).toThrow(/no longer accepting/u);
  });

  it("continues cleanup even when the warning logger throws", async () => {
    const calls: string[] = [];
    const rollback = new StartupRollback({
      warn: () => {
        throw new Error("logger unavailable");
      },
    });
    rollback.defer("last", () => {
      calls.push("last");
    });
    rollback.defer("failing", () => {
      calls.push("failing");
      throw new Error("cleanup failed");
    });

    await expect(rollback.rollback()).resolves.toBeUndefined();
    expect(calls).toEqual(["failing", "last"]);
  });

  it("rethrows the original startup error after best-effort cleanup", async () => {
    const original = new Error("persistence initialization failed");
    const rollback = new StartupRollback({ warn: vi.fn() });
    const cleaned = vi.fn();
    rollback.defer("history storage", cleaned);
    rollback.defer("worker", () => {
      throw new Error("worker close failed");
    });

    await expect(rollback.rethrow(original)).rejects.toBe(original);
    expect(cleaned).toHaveBeenCalledTimes(1);
  });
});

describe("listenForStartup", () => {
  it("resolves only after listening and removes temporary listeners", async () => {
    const { server, listen } = serverDouble((events) => {
      queueMicrotask(() => events.emit("listening"));
    });

    await expect(listenForStartup(server, 3200, "127.0.0.1")).resolves.toBeUndefined();

    expect(listen).toHaveBeenCalledWith(3200, "127.0.0.1");
    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("rejects with the original asynchronous bind error and removes listeners", async () => {
    const original = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    const { server } = serverDouble((events) => {
      queueMicrotask(() => events.emit("error", original));
    });

    await expect(listenForStartup(server, 3200, "127.0.0.1")).rejects.toBe(original);

    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("rejects synchronous listen failures without retaining listeners", async () => {
    const original = new Error("invalid listen options");
    const { server } = serverDouble(() => {
      throw original;
    });

    await expect(listenForStartup(server, -1, "invalid")).rejects.toBe(original);

    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });
});
