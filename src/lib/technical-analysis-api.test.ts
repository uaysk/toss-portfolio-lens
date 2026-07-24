import { describe, expect, it, vi } from "vitest";
import {
  TechnicalAnalysisApiError,
  parseTechnicalSearchResults,
  parseTechnicalTradeMarkers,
  requestTechnicalAnalysis,
  requestTechnicalTradeMarkers,
  searchTechnicalInstruments,
  technicalApiErrorMessage,
} from "./technical-analysis-api";
import type { TechnicalAnalysisRequest, TechnicalTradeMarkersPayload } from "./technical-analysis";

const request: TechnicalAnalysisRequest = {
  symbols: ["005930"],
  fromDate: "2026-01-01",
  toDate: "2026-07-01",
  interval: "1d",
  adjusted: true,
  currencyMode: "KRW",
  responseMode: "full_series",
  indicators: [{ id: "sma-primary", kind: "sma" }],
};

describe("technical analysis API boundary", () => {
  it("normalizes wrapped and legacy search results at the HTTP boundary", () => {
    expect(parseTechnicalSearchResults({
      result: {
        instruments: [
          { symbol: " aapl ", name: " Apple ", market: "NASDAQ", currency: "USD", assetType: "stock" },
          { symbol: "", name: "ignored" },
          { name: "missing symbol" },
        ],
      },
    })).toEqual([{
      symbol: "AAPL",
      name: "Apple",
      market: "NASDAQ",
      currency: "USD",
      assetType: "stock",
    }]);
    expect(parseTechnicalSearchResults({ instruments: [{ symbol: "005930", securityType: "equity" }] }))
      .toEqual([{ symbol: "005930", name: "005930", market: "", currency: "KRW", assetType: "equity" }]);
  });

  it("unwraps trade markers from either supported response envelope", () => {
    const markers = [{ symbol: "AAPL" }] as unknown as TechnicalTradeMarkersPayload["markers"];
    expect(parseTechnicalTradeMarkers({ result: { markers } })?.markers).toBe(markers);
    expect(parseTechnicalTradeMarkers({ markers })?.markers).toBe(markers);
    expect(parseTechnicalTradeMarkers({ result: {} })).toBeUndefined();
  });

  it("keeps provider details behind the expected error-message contract", () => {
    expect(technicalApiErrorMessage({ error: { message: "요청 오류" } }, "fallback")).toBe("요청 오류");
    expect(technicalApiErrorMessage({ message: "legacy" }, "fallback")).toBe("legacy");
    expect(technicalApiErrorMessage({ error: { message: " " } }, "fallback")).toBe("fallback");
  });

  it("serializes search requests and parses successful responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: { instruments: [{ symbol: "aapl", currency: "USD" }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(searchTechnicalInstruments("apple", { fetchImpl })).resolves.toEqual([{
      symbol: "AAPL",
      name: "AAPL",
      market: "",
      currency: "USD",
      assetType: undefined,
    }]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/portfolio/tools/search_instruments", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: "apple", limit: 12 }),
    }));
  });

  it("returns typed analysis and exposes status without inventing invalid data", async () => {
    const validPayload = {
      run_id: "run-1",
      reused: false,
      response_mode: "full_series",
      price_series: [],
      technical_analysis: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations: [],
      },
    };
    await expect(requestTechnicalAnalysis(request, {
      fetchImpl: async () => new Response(JSON.stringify(validPayload), { status: 200 }),
      failureMessage: "분석 실패",
      invalidResponseMessage: "응답 오류",
    })).resolves.toMatchObject({ run_id: "run-1" });

    await expect(requestTechnicalAnalysis(request, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "인증 필요" } }), { status: 401 }),
      failureMessage: "분석 실패",
      invalidResponseMessage: "응답 오류",
    })).rejects.toMatchObject({ status: 401, message: "인증 필요" } satisfies Partial<TechnicalAnalysisApiError>);

    await expect(requestTechnicalAnalysis(request, {
      fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
      failureMessage: "분석 실패",
      invalidResponseMessage: "응답 오류",
    })).rejects.toMatchObject({ status: 200, message: "응답 오류" } satisfies Partial<TechnicalAnalysisApiError>);
  });

  it("builds an encoded marker query and rejects malformed success payloads", async () => {
    const markers = {
      schema_version: "technical-trade-markers/v1",
      markers: [],
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ result: markers }), { status: 200 })
    ));

    await expect(requestTechnicalTradeMarkers({
      accountId: "account 1",
      fromDate: "2026-01-01",
      toDate: "2026-07-01",
      symbols: ["005930", "AAPL"],
    }, { fetchImpl })).resolves.toMatchObject(markers);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/api/portfolio/technical/trades?account=account+1&from=2026-01-01&to=2026-07-01&symbols=005930%2CAAPL",
    );

    await expect(requestTechnicalTradeMarkers({
      accountId: "account-1",
      fromDate: "2026-01-01",
      toDate: "2026-07-01",
      symbols: ["005930"],
    }, {
      fetchImpl: async () => new Response(JSON.stringify({ message: "marker 응답 오류" }), { status: 200 }),
    })).rejects.toMatchObject({ status: 200, message: "marker 응답 오류" } satisfies Partial<TechnicalAnalysisApiError>);
  });
});
