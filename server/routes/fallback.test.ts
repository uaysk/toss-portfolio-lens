import path from "node:path";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerApiAndSpaFallbacks } from "./fallback.js";

describe("SPA static fallbacks", () => {
  it("overrides production immutable caching for the exact comparison report", () => {
    const staticMiddleware = vi.fn();
    const staticSpy = vi.spyOn(express, "static").mockReturnValue(staticMiddleware);
    const app = {
      use: vi.fn(),
      get: vi.fn(),
    } as unknown as Express;
    const clientDirectory = "/tmp/portfolio-client";
    registerApiAndSpaFallbacks(app, { clientDirectory, production: true });

    const options = staticSpy.mock.calls[0]?.[1];
    expect(options).toMatchObject({ maxAge: "1y", immutable: true });
    const setHeader = vi.fn();
    options?.setHeaders?.(
      { setHeader } as never,
      path.join(clientDirectory, "reports", "crypto-scalping-model-comparison.html"),
      {} as never,
    );
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");

    setHeader.mockClear();
    options?.setHeaders?.(
      { setHeader } as never,
      path.join(clientDirectory, "assets", "app.js"),
      {} as never,
    );
    expect(setHeader).not.toHaveBeenCalled();
    staticSpy.mockRestore();
  });
});
