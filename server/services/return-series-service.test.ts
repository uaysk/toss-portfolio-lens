import { describe, expect, it, vi } from "vitest";
import { combineDataRevisions, ReturnSeriesService } from "./return-series-service.js";
import type { MarketDataService } from "./market-data-service.js";
import { WorkerInputSchema } from "../worker/contracts.js";

describe("return series data revision", () => {
  it.each([2, 20])("%i종목 revision을 worker 계약의 64자 해시로 축약한다", (count) => {
    const revisions = Array.from({ length: count }, (_, index) => String(index).padStart(64, "a"));
    const combined = combineDataRevisions(revisions);
    expect(combined).toMatch(/^[a-f0-9]{64}$/);
    expect(combineDataRevisions([...revisions].reverse())).toBe(combined);
    expect(WorkerInputSchema.safeParse({
      schema_version: "1.0",
      engine_version: "portfolio-lens-rust-2026.07.4",
      run_id: "run-1",
      job_kind: "optimization",
      data_revision: combined,
      request_hash: "b".repeat(64),
      payload: {},
    }).success).toBe(true);
  });

  it("revision 하나가 바뀌면 결합 해시도 바뀐다", () => {
    expect(combineDataRevisions(["a".repeat(64), "b".repeat(64)]))
      .not.toBe(combineDataRevisions(["a".repeat(64), "c".repeat(64)]));
  });

  it("load 종료 후 market snapshot을 진단 metadata로만 기록한다", async () => {
    const getPriceSeries = vi.fn().mockImplementation(async ({ symbol }: { symbol: string }) => ({
      instrument: { symbol, name: symbol, market: "TEST", currency: "USD", assetType: "ETF" },
      points: [
        { date: "2024-01-01", close: 100 },
        { date: "2024-01-02", close: 101 },
      ],
      effectivePeriod: { from: "2024-01-01", to: "2024-01-02" },
      dataRevision: symbol === "AAA" ? "per-symbol-a" : "per-symbol-b",
      warnings: [],
      dataQuality: {
        observations: 2,
        missingFxObservations: 0,
        carriedFxObservations: 0,
        listingDateConsistency: "unavailable",
      },
    }));
    const marketData = {
      getPriceSeries,
      repository: { dataRevision: vi.fn().mockResolvedValue("shared-market-snapshot") },
    } as unknown as MarketDataService;

    const result = await new ReturnSeriesService(marketData).load({
      symbols: ["AAA", "BBB"],
      fromDate: "2024-01-01",
      toDate: "2024-01-02",
      currencyMode: "local",
      adjusted: true,
    });

    expect(result.dataRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dataQuality).toMatchObject({
      market_snapshot_revision: "shared-market-snapshot",
      data_revision_basis: {
        algorithm: "sha256",
        content: "loaded_converted_price_series",
        fields: ["instrument_id", "label", "date", "converted_close"],
        market_snapshot_revision_included: false,
      },
    });
    expect(marketData.repository.dataRevision).toHaveBeenCalledOnce();
  });

  it("같은 market snapshot에서도 실제 환산 종가가 바뀌면 content revision이 달라진다", async () => {
    let closeOffset = 0;
    const getPriceSeries = vi.fn().mockImplementation(async ({ symbol }: { symbol: string }) => ({
      instrument: { symbol, name: `${symbol} label`, market: "TEST", currency: "USD", assetType: "ETF" },
      points: [
        { date: "2024-01-01", close: 100 + closeOffset },
        { date: "2024-01-02", close: 101 + closeOffset },
      ],
      effectivePeriod: { from: "2024-01-01", to: "2024-01-02" },
      dataRevision: "ignored-per-series-revision",
      warnings: [],
      dataQuality: {
        observations: 2,
        missingFxObservations: 0,
        carriedFxObservations: 0,
        listingDateConsistency: "unavailable",
      },
    }));
    const marketData = {
      getPriceSeries,
      repository: { dataRevision: vi.fn().mockResolvedValue("same-market-snapshot") },
    } as unknown as MarketDataService;
    const service = new ReturnSeriesService(marketData);
    const input = {
      symbols: ["AAA", "BBB"],
      fromDate: "2024-01-01",
      toDate: "2024-01-02",
      currencyMode: "KRW" as const,
      adjusted: true,
    };

    const before = await service.load(input);
    closeOffset = 1;
    const after = await service.load(input);

    expect(before.dataQuality).toMatchObject({ market_snapshot_revision: "same-market-snapshot" });
    expect(after.dataQuality).toMatchObject({ market_snapshot_revision: "same-market-snapshot" });
    expect(after.dataRevision).not.toBe(before.dataRevision);
  });

  it("market snapshot만 바뀌고 반환 content가 같으면 같은 revision을 유지한다", async () => {
    const getPriceSeries = vi.fn().mockImplementation(async ({ symbol }: { symbol: string }) => ({
      instrument: { symbol, name: `${symbol} label`, market: "TEST", currency: "USD", assetType: "ETF" },
      points: [
        { date: "2024-01-01", close: 100 },
        { date: "2024-01-02", close: 101 },
      ],
      effectivePeriod: { from: "2024-01-01", to: "2024-01-02" },
      dataRevision: `ignored-${symbol}`,
      warnings: [],
      dataQuality: {
        observations: 2,
        missingFxObservations: 0,
        carriedFxObservations: 0,
        listingDateConsistency: "unavailable",
      },
    }));
    const snapshotRevision = vi.fn()
      .mockResolvedValueOnce("market-snapshot-a")
      .mockResolvedValueOnce("market-snapshot-b");
    const marketData = {
      getPriceSeries,
      repository: { dataRevision: snapshotRevision },
    } as unknown as MarketDataService;
    const service = new ReturnSeriesService(marketData);
    const input = {
      symbols: ["AAA", "BBB"],
      fromDate: "2024-01-01",
      toDate: "2024-01-02",
      currencyMode: "KRW" as const,
      adjusted: true,
    };

    const first = await service.load(input);
    const second = await service.load(input);

    expect(first.dataQuality).toMatchObject({ market_snapshot_revision: "market-snapshot-a" });
    expect(second.dataQuality).toMatchObject({ market_snapshot_revision: "market-snapshot-b" });
    expect(second.dataRevision).toBe(first.dataRevision);
  });
});
