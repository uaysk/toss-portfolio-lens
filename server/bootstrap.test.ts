import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const importEffects = vi.hoisted(() => ({
  createServer: vi.fn(),
  eventLoopLagMonitor: vi.fn(),
  eventLoopLagStart: vi.fn(),
  openConfiguredHistoryStore: vi.fn(),
  warnReadOnlyApiTokenFallbackOnce: vi.fn(),
}));

vi.mock("node:http", async () => ({
  ...await vi.importActual<typeof import("node:http")>("node:http"),
  createServer: importEffects.createServer,
}));

vi.mock("./observability/event-loop-monitor.js", () => ({
  EventLoopLagMonitor: class {
    constructor() {
      importEffects.eventLoopLagMonitor();
    }

    start(): void {
      importEffects.eventLoopLagStart();
    }
  },
}));

vi.mock("./storage.js", () => ({
  openConfiguredHistoryStore: importEffects.openConfiguredHistoryStore,
}));

vi.mock("./startup-warning.js", () => ({
  warnReadOnlyApiTokenFallbackOnce: importEffects.warnReadOnlyApiTokenFallbackOnce,
}));

describe("server bootstrap boundary", () => {
  it("imports without starting storage, monitors, timers, listeners, or runtime assembly", async () => {
    vi.useFakeTimers();
    const signalListeners = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const timers = vi.getTimerCount();

    try {
      const module = await import("./bootstrap.js");

      expect(module.bootstrap).toBeTypeOf("function");
      expect(importEffects.createServer).not.toHaveBeenCalled();
      expect(importEffects.warnReadOnlyApiTokenFallbackOnce).not.toHaveBeenCalled();
      expect(importEffects.eventLoopLagMonitor).not.toHaveBeenCalled();
      expect(importEffects.eventLoopLagStart).not.toHaveBeenCalled();
      expect(importEffects.openConfiguredHistoryStore).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timers);
      expect(process.listenerCount("SIGINT")).toBe(signalListeners.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(signalListeners.sigterm);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("keeps the executable entrypoint limited to config loading and bootstrap", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('import { bootstrap } from "./bootstrap.js"');
    expect(source).toContain("const config = loadConfig()");
    expect(source).toContain("await bootstrap(config)");
    expect(source).not.toMatch(/createServer|\.listen\(|setInterval|setTimeout|process\.on/);
  });
});
