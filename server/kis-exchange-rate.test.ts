import { describe, expect, it, vi } from "vitest";
import { KisExchangeRateClient, type KisExchangeRateConfig } from "./kis-exchange-rate.js";

const config: KisExchangeRateConfig = {
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  environment: "demo",
  requestIntervalMs: 600,
  timeoutMs: 5_000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("KisExchangeRateClient", () => {
  it("토큰을 재사용하고 30일 단위로 USD/KRW 일별 종가를 조회한다", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/oauth2/tokenP")) {
        return json({ access_token: "access-token", expires_in: 86_400 });
      }
      const parsed = new URL(url);
      const from = parsed.searchParams.get("FID_INPUT_DATE_1");
      return json({
        rt_cd: "0",
        output2: from === "20220801"
          ? [{ stck_bsop_date: "20220803", ovrs_nmix_prpr: "1310.50" }]
          : [{ stck_bsop_date: "20220902", ovrs_nmix_prpr: "1362.40" }],
      });
    }) as unknown as typeof fetch;
    const client = new KisExchangeRateClient(config, {
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      now: () => 1_000,
    });

    await expect(client.getUsdKrwExchangeRates("2022-08-01", "2022-09-02")).resolves.toEqual([
      { date: "2022-08-03", rate: 1_310.5, timestamp: "2022-08-03T15:30:00+09:00" },
      { date: "2022-09-02", rate: 1_362.4, timestamp: "2022-09-02T15:30:00+09:00" },
    ]);
    expect(requests.filter((url) => url.endsWith("/oauth2/tokenP"))).toHaveLength(1);
    const quoteRequests = requests.filter((url) => url.includes("inquire-daily-chartprice"));
    expect(quoteRequests).toHaveLength(2);
    expect(quoteRequests[0]).toContain("FID_INPUT_DATE_1=20220801");
    expect(quoteRequests[0]).toContain("FID_INPUT_DATE_2=20220830");
    expect(quoteRequests[1]).toContain("FID_INPUT_DATE_1=20220831");
    expect(quoteRequests[1]).toContain("FID_INPUT_DATE_2=20220902");
  });

  it("호출 제한 응답은 지수 백오프로 재시도한다", async () => {
    let quoteAttempts = 0;
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) return json({ access_token: "access-token", expires_in: 86_400 });
      quoteAttempts += 1;
      if (quoteAttempts === 1) return json({ rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수 초과" });
      return json({ rt_cd: "0", output2: [{ stck_bsop_date: "20220803", ovrs_nmix_prpr: "1310.5" }] });
    }) as unknown as typeof fetch;
    const client = new KisExchangeRateClient(config, { fetchImpl, sleepImpl, now: () => 1_000 });

    await expect(client.getUsdKrwExchangeRates("2022-08-03", "2022-08-03")).resolves.toHaveLength(1);
    expect(quoteAttempts).toBe(2);
    expect(sleepImpl).toHaveBeenCalledWith(1_000);
  });
});
