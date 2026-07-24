import { describe, expect, it, vi } from "vitest";
import {
  BinanceServerCredentials,
  BinanceSignedReadProbe,
  loadBinanceServerCredentials,
} from "./binance-credentials.js";

describe("Binance credential isolation", () => {
  it("prefers absolute file overrides and never serializes credential material", () => {
    const readFile = vi.fn((path: string) => (
      path.endsWith("api") ? "file-api-key-1234567890" : "file-secret-1234567890"
    ));
    const loaded = loadBinanceServerCredentials({
      BINANCE_API_KEY: "env-api-key-1234567890",
      BINANCE_SECRET_KEY: "env-secret-1234567890",
      BINANCE_API_KEY_FILE: "/run/secrets/binance-api",
      BINANCE_SECRET_KEY_FILE: "/run/secrets/binance-secret",
    }, readFile);
    expect(loaded).toMatchObject({ configured: true, source: "file_override" });
    expect(readFile).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(loaded);
    expect(serialized).not.toContain("file-api-key");
    expect(serialized).not.toContain("file-secret");
    expect(serialized).not.toContain("env-api-key");
  });

  it("fails closed on bad paths, unreadable files, and partial configuration", () => {
    expect(loadBinanceServerCredentials({
      BINANCE_API_KEY_FILE: "relative/key",
      BINANCE_SECRET_KEY: "secret-value-1234567890",
    })).toMatchObject({ configured: false, error: "invalid_file_path" });
    expect(loadBinanceServerCredentials({
      BINANCE_API_KEY_FILE: "/run/api",
      BINANCE_SECRET_KEY_FILE: "/run/secret",
    }, () => {
      throw new Error("do not expose this path");
    })).toMatchObject({ configured: false, error: "file_unreadable" });
    expect(loadBinanceServerCredentials({
      BINANCE_API_KEY: "api-value-1234567890",
    })).toMatchObject({ configured: false, error: "partial_configuration" });
  });

  it("reduces signed account reads to a boolean/enum status and discards balances", async () => {
    const credentials = new BinanceServerCredentials(
      "api-value-1234567890",
      "secret-value-1234567890",
    );
    const data = vi.fn().mockResolvedValue({
      totalWalletBalance: "sensitive-balance",
      positions: [{ symbol: "BTCUSDT" }],
    });
    const success = new BinanceSignedReadProbe({
      credentials,
      rest: { accountInformationV3: vi.fn().mockResolvedValue({ data }) },
    });
    const status = await success.probe();
    expect(status).toEqual({
      configured: true,
      signedReadSucceeded: true,
      state: "ok",
    });
    expect(JSON.stringify(status)).not.toContain("sensitive");

    const unauthorized = new BinanceSignedReadProbe({
      credentials,
      rest: {
        accountInformationV3: vi.fn().mockRejectedValue({
          response: { status: 401, data: { msg: "contains-sensitive-detail" } },
        }),
      },
    });
    expect(await unauthorized.probe()).toEqual({
      configured: true,
      signedReadSucceeded: false,
      state: "unauthorized",
    });
  });
});
