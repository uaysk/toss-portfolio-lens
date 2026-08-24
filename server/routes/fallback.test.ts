import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerApiAndSpaFallbacks } from "./fallback.js";

describe("SPA static fallbacks", () => {
  it("limits production immutable caching to Vite assets", () => {
    const staticMiddleware = vi.fn();
    const staticSpy = vi.spyOn(express, "static").mockReturnValue(staticMiddleware);
    const app = {
      use: vi.fn(),
      get: vi.fn(),
    } as unknown as Express;
    const clientDirectory = mkdtempSync(path.join(tmpdir(), "portfolio-client-"));
    mkdirSync(path.join(clientDirectory, ".vite"));
    writeFileSync(path.join(clientDirectory, ".vite", "manifest.json"), JSON.stringify({
      "index.html": {
        file: "assets/app-deadbeef.js",
      },
    }));
    registerApiAndSpaFallbacks(app, { clientDirectory, production: true });

    const options = staticSpy.mock.calls[0]?.[1];
    expect(options).toMatchObject({ maxAge: 0, immutable: false });
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
      path.join(clientDirectory, "assets", "app-deadbeef.js"),
      {} as never,
    );
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );

    setHeader.mockClear();
    options?.setHeaders?.(
      { setHeader } as never,
      path.join(clientDirectory, "assets", "not-in-manifest-deadbeef.js"),
      {} as never,
    );
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");

    setHeader.mockClear();
    options?.setHeaders?.(
      { setHeader } as never,
      path.join(clientDirectory, "runtime-config.json"),
      {} as never,
    );
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    staticSpy.mockRestore();
    rmSync(clientDirectory, { force: true, recursive: true });
  });
});
