import { describe, expect, it, vi } from "vitest";
import {
  KisRestClient,
  KisRestError,
  KisRestValidationError,
  type KisRestClientConfig,
} from "./kis-rest-client.js";

const NOW = Date.parse("2026-07-21T10:00:30+09:00");

const config: KisRestClientConfig = {
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  environment: "demo",
  requestIntervalMs: 250,
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 2_000,
};

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function volumeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mksc_shrn_iscd: "005930",
    hts_kor_isnm: "삼성전자",
    data_rank: "1",
    stck_prpr: "73500",
    prdy_vrss: "1200",
    prdy_ctrt: "1.66",
    acml_vol: "12,345,678",
    acml_tr_pbmn: "905000000000",
    avrg_vol: "8300000",
    vol_inrt: "148.74",
    vol_tnrt: "0.21",
    tr_pbmn_tnrt: "0.18",
    ...overrides,
  };
}

function fluctuationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stck_shrn_iscd: "000660",
    hts_kor_isnm: "SK하이닉스",
    data_rank: "2",
    stck_prpr: "189500",
    prdy_vrss: "-3500",
    prdy_ctrt: "-1.81",
    acml_vol: "3210000",
    acml_tr_pbmn: "612000000000",
    stck_oprc: "193000",
    stck_hgpr: "194500",
    stck_lwpr: "188000",
    ...overrides,
  };
}

function minuteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stck_bsop_date: "20260721",
    stck_cntg_hour: "095900",
    stck_prpr: "73400",
    stck_oprc: "73300",
    stck_hgpr: "73500",
    stck_lwpr: "73200",
    cntg_vol: "12345",
    acml_vol: "1000000",
    acml_tr_pbmn: "73400000000",
    ...overrides,
  };
}

describe("KisRestClient", () => {
  it("validates all configured pacing and retry limits", () => {
    expect(() => new KisRestClient({ ...config, maxAttempts: 0 })).toThrow(KisRestValidationError);
    expect(() => new KisRestClient({ ...config, requestIntervalMs: 0 })).toThrow("requestIntervalMs");
    expect(() => new KisRestClient({ ...config, retryBaseMs: -1 })).toThrow("retryBaseMs");
    expect(() => new KisRestClient({ ...config, retryMaxMs: 50 })).toThrow("retryMaxMs");
  });

  it("coalesces concurrent token requests and sends the documented ranking TR IDs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/oauth2/tokenP")) {
        await Promise.resolve();
        return json({ access_token: "shared-token", expires_in: 86_400 });
      }
      if (url.includes("volume-rank")) return json({ rt_cd: "0", output: [volumeRow()] });
      return json({ rt_cd: "0", output: [fluctuationRow()] });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, {
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      now: () => NOW,
    });

    const [volume, fluctuation] = await Promise.all([
      client.getVolumeRanking({ basisCode: "3" }),
      client.getFluctuationRanking({ sortCode: "0" }),
    ]);

    expect(volume.items[0]).toMatchObject({ symbol: "005930", accumulatedTradingAmount: 905_000_000_000 });
    expect(fluctuation.items[0]).toMatchObject({ symbol: "000660", changeRate: -1.81 });
    expect(requests.filter(({ url }) => url.endsWith("/oauth2/tokenP"))).toHaveLength(1);
    const volumeRequest = requests.find(({ url }) => url.includes("volume-rank"));
    const fluctuationRequest = requests.find(({ url }) => url.includes("ranking/fluctuation"));
    expect(new Headers(volumeRequest?.init?.headers).get("tr_id")).toBe("FHPST01710000");
    expect(new Headers(fluctuationRequest?.init?.headers).get("tr_id")).toBe("FHPST01700000");
    expect(new Headers(volumeRequest?.init?.headers).get("authorization")).toBe("Bearer shared-token");
  });

  it("normalizes volume ranking rows and reports malformed rows without inventing zero values", async () => {
    let rankingUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) return json({ access_token: "token", expires_in: 60 });
      rankingUrl = url;
      return json({
        rt_cd: "0",
        output: [volumeRow(), volumeRow({ mksc_shrn_iscd: "035420", stck_prpr: "not-a-number" }), null],
      });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, { fetchImpl, sleepImpl: async () => {}, now: () => NOW });

    const result = await client.getVolumeRanking({
      market: "UN",
      marketCode: "0000",
      basisCode: "3",
      minPrice: 1_000,
      maxPrice: 500_000,
      minVolume: 10_000,
      exclusionCode: "1011111111",
    });

    expect(result.quality).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      symbol: "005930",
      name: "삼성전자",
      rank: 1,
      price: 73_500,
      changeAmount: 1_200,
      changeRate: 1.66,
      accumulatedVolume: 12_345_678,
      accumulatedTradingAmount: 905_000_000_000,
      averageVolume: 8_300_000,
      volumeIncreaseRate: 148.74,
      volumeTurnoverRate: 0.21,
      tradingAmountTurnoverRate: 0.18,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ index: 1, fields: ["price"], code: "malformed-row" }),
      expect.objectContaining({ index: 2, fields: ["row"], code: "malformed-row" }),
    ]);
    const params = new URL(rankingUrl).searchParams;
    expect(params.get("FID_COND_MRKT_DIV_CODE")).toBe("UN");
    expect(params.get("FID_BLNG_CLS_CODE")).toBe("3");
    expect(params.get("FID_INPUT_PRICE_1")).toBe("1000");
    expect(params.get("FID_VOL_CNT")).toBe("10000");
  });

  it("uses Retry-After and configured exponential backoff without hardcoded attempt counts", async () => {
    let quoteAttempt = 0;
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) return json({ access_token: "token", expires_in: 86_400 });
      quoteAttempt += 1;
      if (quoteAttempt === 1) {
        return json({ rt_cd: "1", msg_cd: "EGW00201", msg1: "rate limited" }, 429, { "retry-after": "1" });
      }
      if (quoteAttempt === 2) return json({ rt_cd: "1", msg_cd: "EGW00201", msg1: "rate limited" });
      return json({ rt_cd: "0", output: [fluctuationRow()] });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, { fetchImpl, sleepImpl, now: () => NOW });

    await expect(client.getFluctuationRanking({ sortCode: "1" })).resolves.toMatchObject({ quality: "available" });
    expect(quoteAttempt).toBe(3);
    expect(sleepImpl).toHaveBeenCalledWith(1_000);
    expect(sleepImpl).toHaveBeenCalledWith(200);
  });

  it("clears a rejected cached token and obtains a replacement on a retry", async () => {
    let tokenAttempt = 0;
    let quoteAttempt = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) {
        tokenAttempt += 1;
        return json({ access_token: `token-${tokenAttempt}`, expires_in: 86_400 });
      }
      quoteAttempt += 1;
      if (quoteAttempt === 1) return json({ rt_cd: "1", msg_cd: "EGW00123", msg1: "expired" }, 401);
      return json({ rt_cd: "0", output: [volumeRow()] });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, {
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      now: () => NOW,
    });

    await expect(client.getVolumeRanking({ basisCode: "0" })).resolves.toMatchObject({ quality: "available" });
    expect(tokenAttempt).toBe(2);
    expect(quoteAttempt).toBe(2);
  });

  it("strictly validates current-day minute input and returns sorted final/forming bars", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) return json({ access_token: "token", expires_in: 86_400 });
      return json({
        rt_cd: "0",
        output2: [
          minuteRow({ stck_cntg_hour: "100000", stck_prpr: "73600", stck_hgpr: "73700" }),
          minuteRow(),
          minuteRow(),
          minuteRow({ stck_cntg_hour: "095800", stck_hgpr: "70000" }),
        ],
      });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, { fetchImpl, sleepImpl: async () => {}, now: () => NOW });

    await expect(client.getCurrentDayMinutes({
      symbol: "005930",
      sessionDate: "20260720",
      inputTime: "100000",
    })).rejects.toThrow("current Seoul trading date");
    await expect(client.getCurrentDayMinutes({
      symbol: "005930",
      sessionDate: "20260721",
      inputTime: "246000",
    })).rejects.toThrow("HHMMSS");

    const result = await client.getCurrentDayMinutes({
      symbol: "005930",
      sessionDate: "20260721",
      inputTime: "100000",
      market: "UN",
    });
    expect(result.quality).toBe("partial");
    expect(result.items.map(({ timestamp, status }) => ({ timestamp, status }))).toEqual([
      { timestamp: "2026-07-21T09:59:00+09:00", status: "final" },
      { timestamp: "2026-07-21T10:00:00+09:00", status: "forming" },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ index: 2, code: "duplicate-row" }),
      expect.objectContaining({ index: 3, code: "malformed-row", fields: ["ohlc"] }),
    ]);
    const minuteRequestUrl = String(fetchImpl.mock.calls.at(-1)?.[0]);
    const params = new URL(minuteRequestUrl).searchParams;
    expect(params.get("FID_COND_MRKT_DIV_CODE")).toBe("UN");
    expect(params.get("FID_INPUT_HOUR_1")).toBe("100000");
  });

  it("fails explicitly when a provider result collection has the wrong shape", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth2/tokenP")) return json({ access_token: "token", expires_in: 86_400 });
      return json({ rt_cd: "0", output: null });
    }) as unknown as typeof fetch;
    const client = new KisRestClient(config, { fetchImpl, sleepImpl: async () => {}, now: () => NOW });

    await expect(client.getVolumeRanking({ basisCode: "0" })).rejects.toMatchObject<KisRestError>({
      code: "invalid-response",
      retryable: false,
    });
  });

  it("does not expose credentials in normalized network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network failed for ${config.appKey}/${config.appSecret}`);
    }) as unknown as typeof fetch;
    const client = new KisRestClient({ ...config, maxAttempts: 1 }, {
      fetchImpl,
      sleepImpl: async () => {},
      now: () => NOW,
    });

    const error = await client.getVolumeRanking({ basisCode: "0" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KisRestError);
    expect(String(error)).not.toContain(config.appKey);
    expect(String(error)).not.toContain(config.appSecret);
  });
});
