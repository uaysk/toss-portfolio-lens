import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../database.js";
import { ArtifactRepository } from "../repositories/artifact-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { ArtifactService } from "./artifact-service.js";
import type { MarketDataService, MarketSeriesResult } from "./market-data-service.js";
import { RunService } from "./run-service.js";
import type { RustComputeClient } from "../worker/rust-client.js";
import {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_KINDS,
  TechnicalAnalysisService,
  projectTechnicalAnalysisLatest,
  type TechnicalAnalysisRequest,
  type TechnicalAnalysisWorkerPayload,
} from "./technical-analysis-service.js";

const databases: SqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function series(
  symbol: string,
  price: number,
  volumes: readonly [number | null, number | null] = [null, null],
): MarketSeriesResult {
  const name = symbol === "AAA" ? "Alpha" : "Beta";
  return {
    instrument: {
      symbol,
      name,
      market: "TEST",
      currency: "KRW",
      assetType: symbol === "BBB" ? "ETF" : "STOCK",
    },
    interval: "1d",
    adjusted: true,
    currencyMode: "KRW",
    currency: "KRW",
    points: [
      {
        date: "2024-01-02",
        periodStart: "2024-01-02",
        periodEnd: "2024-01-02",
        observations: 1,
        open: price,
        high: price + 2,
        low: price - 1,
        close: price + 1,
        localOpen: price,
        localHigh: price + 2,
        localLow: price - 1,
        localClose: price + 1,
        fxRate: 1,
        volume: volumes[0],
      },
      {
        date: "2024-01-03",
        periodStart: "2024-01-03",
        periodEnd: "2024-01-03",
        observations: 1,
        open: price + 1,
        high: price + 3,
        low: price,
        close: price + 2,
        localOpen: price + 1,
        localHigh: price + 3,
        localLow: price,
        localClose: price + 2,
        fxRate: 1,
        volume: volumes[1],
      },
    ],
    requestedPeriod: { from: "2024-01-01", to: "2024-01-31" },
    effectivePeriod: { from: "2024-01-02", to: "2024-01-03" },
    dataRevision: "provider-revision",
    assumptions: [],
    warnings: [],
    dataQuality: {
      observations: 2,
      outputObservations: 2,
      volumeObservations: volumes.filter((volume) => volume !== null).length,
      missingVolumeObservations: volumes.filter((volume) => volume === null).length,
      volumeCoverage: volumes.filter((volume) => volume !== null).length / volumes.length,
      volumeStatus: volumes.every((volume) => volume === null)
        ? "volume_unavailable"
        : volumes.some((volume) => volume === null) ? "partial" : "available",
      sourceDailyVolumeObservations: volumes.filter((volume) => volume !== null).length,
      sourceDailyMissingVolumeObservations: volumes.filter((volume) => volume === null).length,
      sourceDailyVolumeCoverage: volumes.filter((volume) => volume !== null).length / volumes.length,
      sourceDailyVolumeStatus: volumes.every((volume) => volume === null)
        ? "volume_unavailable"
        : volumes.some((volume) => volume === null) ? "partial" : "available",
      missingFxObservations: 0,
      carriedFxObservations: 0,
      metadataListDateRole: "provider_listing_metadata_not_verified_inception",
      listingDateConsistency: "unavailable",
    },
  };
}

const baseRequest: TechnicalAnalysisRequest = {
  symbols: ["BBB", "AAA"],
  fromDate: "2024-01-01",
  toDate: "2024-01-31",
  interval: "1d",
  adjusted: true,
  currencyMode: "KRW",
  responseMode: "full_series",
  indicators: [
    { id: "rsi-main", kind: "rsi", parameters: { period: 14 } },
    { id: "sma-main", kind: "sma", parameters: { period: 20 }, instrumentKeys: ["BBB", "AAA"] },
  ],
};

async function harness(input: {
  executionMode?: "inline" | "rust_socket";
  price?: () => number;
  volumes?: () => readonly [number | null, number | null];
  unknownArtifact?: boolean;
  mismatchedArtifact?: boolean;
  engineVersion?: string;
  echoFirstIndicator?: boolean;
  getPriceSeries?: (request: { symbol: string; requireVolume?: boolean }) => Promise<MarketSeriesResult>;
  profileBucketCount?: number;
} = {}) {
  const database = new SqliteDatabase(":memory:");
  databases.push(database);
  const runRepository = new RunRepository(database);
  const artifactRepository = new ArtifactRepository(database);
  await runRepository.initialize();
  await artifactRepository.initialize();
  const artifacts = new ArtifactService(artifactRepository, 1_000, 1_000_000);
  const runs = new RunService(runRepository, artifacts, 2, 10, {
    executionMode: input.executionMode ?? "rust_socket",
  });
  const marketData = {
    getPriceSeries: vi.fn(input.getPriceSeries ?? (async ({ symbol }: { symbol: string }) => (
      series(
        symbol,
        (input.price?.() ?? 100) + (symbol === "BBB" ? 10 : 0),
        input.volumes?.() ?? [null, null],
      )
    ))),
  } as unknown as MarketDataService;
  const indicatorPoints = [
    { date: "2024-01-02", state: "warmup", values: { sma: null } },
    { date: "2024-01-03", state: "available", values: { sma: 102 } },
  ];
  const rustCompute = {
    compute: vi.fn(async (_kind: string, payload: TechnicalAnalysisWorkerPayload) => {
      const requestedIndicator = input.echoFirstIndicator
        ? payload.technical_analysis.indicators[0]
        : undefined;
      const profileBuckets = input.profileBucketCount === undefined
        ? undefined
        : Array.from({ length: input.profileBucketCount }, (_, index) => ({
            index,
            price_low: 100 + index,
            price_high: 101 + index,
            price_mid: 100.5 + index,
            volume: 10,
            volume_percent: 100 / input.profileBucketCount!,
            in_value_area: true,
            is_point_of_control: index === 0,
          }));
      const calculation = {
        instrument_key: "AAA",
        indicator_id: input.profileBucketCount === undefined ? requestedIndicator?.id ?? "sma-main" : "profile",
        kind: input.profileBucketCount === undefined ? requestedIndicator?.kind ?? "sma" : "volume_profile",
        parameters: input.profileBucketCount === undefined
          ? requestedIndicator?.parameters ?? { period: 20 }
          : { bucket_count: 24, price_source: "typical_price", value_area_percent: 70 },
        availability: { status: "available", reason: "calculated" },
        warmup: {
          required_observations: 20,
          observed_observations: 2,
          state: "warming_up",
          first_available_date: null,
        },
        points: indicatorPoints,
        ...(profileBuckets === undefined ? {} : {
          metadata: { approximate: true },
          profile: {
            schema_version: "volume-profile/v1",
            from_date: "2024-01-02",
            to_date: "2024-01-03",
            price_source: "typical_price",
            requested_bucket_count: 24,
            effective_bucket_count: Math.min(profileBuckets.length, 200),
            price_min: 100,
            price_max: 101,
            bucket_width: 1,
            total_volume: 20,
            included_observations: 2,
            missing_volume_observations: 0,
            value_area_percent: 70,
            point_of_control: 100.5,
            value_area_high: 101,
            value_area_low: 100,
            buckets: profileBuckets,
            approximation: "each_bar_full_volume_assigned_to_one_selected_representative_price_bucket",
          },
        }),
      };
      const diagnostics = {
        validation: "strict",
        deterministic_order: "instrument_key_then_indicator_id",
        adjustment_policy: "adjusted",
        instrument_count: 2,
        indicator_definition_count: 2,
        calculation_count: 1,
        total_bar_count: 4,
        catalog: [],
        messages: [],
      };
      return {
        result: {
          schema_version: "technical-analysis-result/v1",
          indicator_engine_version: input.engineVersion ?? TECHNICAL_INDICATOR_ENGINE_VERSION,
          response_mode: "full_series",
          adjustment_policy: "adjusted",
          calculations: [calculation],
          diagnostics,
        },
        summary: { calculation_count: 1 },
        warnings: [],
        artifacts: [
          {
            type: "technical-indicators",
            content: input.mismatchedArtifact ? [] : [calculation],
            row_count: 1,
          },
          {
            type: "technical-diagnostics",
            content: diagnostics,
            row_count: 1,
          },
          {
            type: "worker-metrics",
            content: { elapsed_ms: 2 },
            row_count: 1,
          },
          ...(input.unknownArtifact ? [{ type: "not-registered", content: {}, row_count: 0 }] : []),
        ],
      };
    }),
  } as unknown as RustComputeClient;
  return {
    marketData,
    runRepository,
    rustCompute,
    service: new TechnicalAnalysisService(marketData, runs, artifacts, rustCompute),
  };
}

function resultOf(value: unknown) {
  return (value as { result: Record<string, unknown>; data_revision: string }).result;
}

describe("TechnicalAnalysisService", () => {
  it("1~2단계 가격 지표 23개를 분기 없이 하나의 canonical worker batch로 전달한다", async () => {
    const { service, marketData, rustCompute } = await harness();
    const priceKinds = TECHNICAL_INDICATOR_KINDS.slice(0, 23);
    const indicators = priceKinds.map((kind, index) => ({
      id: `indicator-${String(index).padStart(2, "0")}`,
      kind,
      ...(kind === "benchmark_relative_strength" ? { parameters: { benchmark_key: "BBB" } } : {}),
    }));

    await service.analyze({ ownerSubject: "owner-a", request: { ...baseRequest, indicators } });

    expect(rustCompute.compute).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(rustCompute.compute).mock.calls[0]?.[1] as TechnicalAnalysisWorkerPayload;
    expect(payload.technical_analysis.indicators).toHaveLength(23);
    expect(payload.technical_analysis.indicators.map((indicator) => indicator.kind)).toEqual(priceKinds);
    expect(vi.mocked(marketData.getPriceSeries).mock.calls.every(([request]) => request.requireVolume === false)).toBe(true);
  });

  it("거래량 지표는 provider volume을 요청하고 국내·미국 stock/ETF 분류와 null coverage를 그대로 worker에 전달한다", async () => {
    const metadata = new Map([
      ["005930", { market: "KRX", currency: "KRW" as const, assetType: "STOCK" }],
      ["069500", { market: "KRX", currency: "KRW" as const, assetType: "ETF" }],
      ["AAPL", { market: "NASDAQ", currency: "USD" as const, assetType: "STOCK" }],
      ["SPY", { market: "NYSE", currency: "USD" as const, assetType: "ETF" }],
    ]);
    const { service, marketData, rustCompute } = await harness({
      getPriceSeries: async ({ symbol }) => {
        const details = metadata.get(symbol)!;
        const base = series(symbol, 100, [1_000, null]);
        return {
          ...base,
          instrument: { ...base.instrument, ...details },
          currencyMode: "local",
          currency: details.currency,
        };
      },
    });

    const response = await service.analyze({
      ownerSubject: "owner-a",
      request: {
        ...baseRequest,
        symbols: ["SPY", "005930", "AAPL", "069500"],
        currencyMode: "local",
        indicators: [{ id: "volume-main", kind: "volume_sma", parameters: { period: 20 } }],
      },
    });

    expect(vi.mocked(marketData.getPriceSeries).mock.calls.every(([request]) => request.requireVolume === true)).toBe(true);
    const payload = vi.mocked(rustCompute.compute).mock.calls[0]?.[1] as TechnicalAnalysisWorkerPayload;
    expect(payload.technical_analysis.instruments.map((instrument) => ({
      key: instrument.key,
      type: instrument.instrument_type,
      volumes: instrument.bars.map((bar) => bar.volume),
    }))).toEqual([
      { key: "005930", type: "stock", volumes: [1_000, null] },
      { key: "069500", type: "etf", volumes: [1_000, null] },
      { key: "AAPL", type: "stock", volumes: [1_000, null] },
      { key: "SPY", type: "etf", volumes: [1_000, null] },
    ]);
    const volumeQuality = (response as {
      data_quality: { volume: Record<string, Record<string, unknown>> };
    }).data_quality.volume;
    expect(volumeQuality).toEqual(Object.fromEntries(Array.from(metadata.keys()).sort().map((symbol) => [
      symbol,
      expect.objectContaining({
        status: "partial",
        observations: 2,
        volume_observations: 1,
        missing_volume_observations: 1,
        coverage: 0.5,
        currency_conversion: "not_applied",
      }),
    ])));
  });

  it("호출자가 bar.volume 조건 대상을 지정하면 가격 지표만 있어도 해당 종목의 provider volume을 요구한다", async () => {
    const { service, marketData } = await harness();

    await service.prepare(baseRequest, { requireVolumeSymbols: ["aaa"] });

    expect(vi.mocked(marketData.getPriceSeries).mock.calls.map(([input]) => ({
      symbol: input.symbol,
      requireVolume: input.requireVolume,
    }))).toEqual([
      { symbol: "AAA", requireVolume: true },
      { symbol: "BBB", requireVolume: false },
    ]);
  });

  it("가격 조회 동시성을 제한하면서 모든 종목을 하나의 worker batch로 유지한다", async () => {
    let active = 0;
    let maximumActive = 0;
    const { service, marketData, rustCompute } = await harness({
      getPriceSeries: async ({ symbol }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return series(symbol, 100);
      },
    });
    const symbols = Array.from({ length: 14 }, (_, index) => `S${String(index).padStart(3, "0")}`);

    await service.analyze({
      ownerSubject: "owner-a",
      request: { ...baseRequest, symbols, indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 } }] },
    });

    expect(marketData.getPriceSeries).toHaveBeenCalledTimes(14);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
    expect(rustCompute.compute).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(rustCompute.compute).mock.calls[0]?.[1] as TechnicalAnalysisWorkerPayload;
    expect(payload.technical_analysis.instruments).toHaveLength(14);
  });

  it("실제 관측수×적용 지표 계산량이 상한을 넘으면 Rust 호출 전에 거부한다", async () => {
    const manyPointSeries = (symbol: string): MarketSeriesResult => {
      const base = series(symbol, 100);
      return {
        ...base,
        points: Array.from({ length: 157 }, (_, index) => {
          const price = 100 + index * 0.01;
          const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
          return {
            ...base.points[0]!,
            date,
            periodStart: date,
            periodEnd: date,
            open: price,
            high: price + 1,
            low: price - 1,
            close: price + 0.5,
            localOpen: price,
            localHigh: price + 1,
            localLow: price - 1,
            localClose: price + 0.5,
          };
        }),
      };
    };
    const { service, rustCompute } = await harness({
      getPriceSeries: async ({ symbol }) => manyPointSeries(symbol),
    });
    const symbols = Array.from({ length: 50 }, (_, index) => `S${String(index).padStart(3, "0")}`);
    const indicators = Array.from({ length: 64 }, (_, index) => ({
      id: `sma-${String(index).padStart(2, "0")}`,
      kind: "sma" as const,
      parameters: { period: 20 },
    }));

    await expect(service.analyze({
      ownerSubject: "owner-a",
      request: { ...baseRequest, symbols, indicators },
    })).rejects.toMatchObject({
      detail: {
        code: "TECHNICAL_ANALYSIS_WORKLOAD_LIMIT",
        field: "indicators",
        details: { work_units: 502_400, maximum_work_units: 500_000 },
      },
    });
    expect(rustCompute.compute).not.toHaveBeenCalled();
  });

  it("52주 위치 기본 period를 interval별로 cache·worker·저장 결과에 동일하게 고정하고 명시값은 보존한다", async () => {
    const { service, runRepository, rustCompute } = await harness({ echoFirstIndicator: true });
    const positionRequest = (interval: "1d" | "1w", period?: number): TechnicalAnalysisRequest => ({
      ...baseRequest,
      symbols: ["AAA"],
      interval,
      indicators: [{
        id: "position-main",
        kind: "fifty_two_week_high_low_position",
        ...(period === undefined ? {} : { parameters: { period } }),
      }],
    });

    const weekly = await service.analyze({ ownerSubject: "owner-a", request: positionRequest("1w") });
    const weeklyExplicitDefault = await service.analyze({ ownerSubject: "owner-a", request: positionRequest("1w", 52) });
    const daily = await service.analyze({ ownerSubject: "owner-a", request: positionRequest("1d") });
    const dailyExplicitDefault = await service.analyze({ ownerSubject: "owner-a", request: positionRequest("1d", 252) });
    const explicit = await service.analyze({ ownerSubject: "owner-a", request: positionRequest("1w", 104) });

    expect(rustCompute.compute).toHaveBeenCalledTimes(3);
    const workerPeriods = vi.mocked(rustCompute.compute).mock.calls.map((call) => (
      (call[1] as TechnicalAnalysisWorkerPayload).technical_analysis.indicators[0]?.parameters?.period
    ));
    expect(workerPeriods).toEqual([52, 252, 104]);
    expect(resultOf(weeklyExplicitDefault).run_id).toBe(resultOf(weekly).run_id);
    expect(resultOf(dailyExplicitDefault).run_id).toBe(resultOf(daily).run_id);

    const cases = [
      { response: weekly, period: 52 },
      { response: daily, period: 252 },
      { response: explicit, period: 104 },
    ];
    for (const { response, period } of cases) {
      const responseResult = resultOf(response);
      const calculation = (responseResult.technical_analysis as {
        calculations: Array<{ parameters?: Record<string, unknown> }>;
      }).calculations[0];
      expect(calculation?.parameters).toEqual({ period });
      const stored = await runRepository.get(String(responseResult.run_id), "owner-a");
      expect(stored?.input).toMatchObject({
        indicators: [{
          id: "position-main",
          kind: "fifty_two_week_high_low_position",
          parameters: { period },
        }],
      });
    }
  });

  it("역사적 변동성 기본 연율화 계수를 일봉 252·주봉 52로 cache·worker·저장 결과에 고정한다", async () => {
    const { service, runRepository, rustCompute } = await harness({ echoFirstIndicator: true });
    const volatilityRequest = (interval: "1d" | "1w", annualization?: number): TechnicalAnalysisRequest => ({
      ...baseRequest,
      symbols: ["AAA"],
      interval,
      indicators: [{
        id: "volatility-main",
        kind: "historical_volatility",
        ...(annualization === undefined ? {} : { parameters: { annualization } }),
      }],
    });

    const weekly = await service.analyze({ ownerSubject: "owner-a", request: volatilityRequest("1w") });
    const weeklyExplicitDefault = await service.analyze({ ownerSubject: "owner-a", request: volatilityRequest("1w", 52) });
    const daily = await service.analyze({ ownerSubject: "owner-a", request: volatilityRequest("1d") });
    const dailyExplicitDefault = await service.analyze({ ownerSubject: "owner-a", request: volatilityRequest("1d", 252) });
    const explicit = await service.analyze({ ownerSubject: "owner-a", request: volatilityRequest("1w", 104) });

    expect(rustCompute.compute).toHaveBeenCalledTimes(3);
    expect(vi.mocked(rustCompute.compute).mock.calls.map((call) => (
      (call[1] as TechnicalAnalysisWorkerPayload).technical_analysis.indicators[0]?.parameters?.annualization
    ))).toEqual([52, 252, 104]);
    expect(resultOf(weeklyExplicitDefault).run_id).toBe(resultOf(weekly).run_id);
    expect(resultOf(dailyExplicitDefault).run_id).toBe(resultOf(daily).run_id);

    for (const { response, annualization } of [
      { response: weekly, annualization: 52 },
      { response: daily, annualization: 252 },
      { response: explicit, annualization: 104 },
    ]) {
      const responseResult = resultOf(response);
      const calculation = (responseResult.technical_analysis as {
        calculations: Array<{ parameters?: Record<string, unknown> }>;
      }).calculations[0];
      expect(calculation?.parameters).toEqual({ annualization });
      const stored = await runRepository.get(String(responseResult.run_id), "owner-a");
      expect(stored?.input).toMatchObject({
        indicators: [{
          id: "volatility-main",
          kind: "historical_volatility",
          parameters: { annualization },
        }],
      });
    }
  });

  it("VWAP 기본값과 signal_date anchor를 cache·worker 계약에 명시적으로 고정한다", async () => {
    const { service, rustCompute } = await harness({ echoFirstIndicator: true, volumes: () => [100, 200] });
    const request = (parameters?: Record<string, string | number>): TechnicalAnalysisRequest => ({
      ...baseRequest,
      symbols: ["AAA"],
      indicators: [{ id: "vwap-main", kind: "vwap_anchored_vwap", ...(parameters ? { parameters } : {}) }],
    });
    const omitted = await service.analyze({ ownerSubject: "owner-a", request: request() });
    const explicit = await service.analyze({ ownerSubject: "owner-a", request: request({ anchor: "period_start", lookback_period: 20, mode: "both" }) });
    const signal = await service.analyze({ ownerSubject: "owner-a", request: request({ anchor: "signal_date", anchor_date: "2024-01-02", lookback_period: 30, mode: "anchored" }) });

    expect(resultOf(explicit).run_id).toBe(resultOf(omitted).run_id);
    expect(rustCompute.compute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rustCompute.compute).mock.calls.map((call) => (
      (call[1] as TechnicalAnalysisWorkerPayload).technical_analysis.indicators[0]?.parameters
    ))).toEqual([
      { anchor: "period_start", lookback_period: 20, mode: "both" },
      { anchor: "signal_date", anchor_date: "2024-01-02", lookback_period: 30, mode: "anchored" },
    ]);
    expect(resultOf(signal).run_id).not.toBe(resultOf(omitted).run_id);
  });

  it("Volume Profile을 단일 종목·단일 정의로 canonicalize하고 최대 200 bucket 계약을 worker 전에 강제한다", async () => {
    const { service, marketData, rustCompute } = await harness({ echoFirstIndicator: true, volumes: () => [100, 200] });
    const focused: TechnicalAnalysisRequest = {
      ...baseRequest,
      symbols: ["AAA"],
      indicators: [{ id: "profile", kind: "volume_profile" }],
    };
    await service.analyze({ ownerSubject: "owner-a", request: focused });
    const payload = vi.mocked(rustCompute.compute).mock.calls[0]?.[1] as TechnicalAnalysisWorkerPayload;
    expect(payload.technical_analysis.indicators[0]).toEqual({
      id: "profile",
      kind: "volume_profile",
      parameters: { bucket_count: 24, price_source: "typical_price", value_area_percent: 70 },
      instrument_keys: ["AAA"],
    });
    expect(marketData.getPriceSeries).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAA", requireVolume: true }));

    for (const request of [
      { ...focused, symbols: ["AAA", "BBB"] },
      { ...focused, indicators: [{ id: "profile", kind: "volume_profile" as const, instrumentKeys: ["AAA", "BBB"] }] },
      { ...focused, indicators: [{ id: "profile-a", kind: "volume_profile" as const }, { id: "profile-b", kind: "volume_profile" as const }] },
      { ...focused, indicators: [{ id: "profile", kind: "volume_profile" as const }, { id: "sma", kind: "sma" as const }] },
      { ...focused, indicators: [{ id: "profile", kind: "volume_profile" as const, parameters: { bucket_count: 201 } }] },
    ]) {
      await expect(service.analyze({ ownerSubject: "owner-b", request: request as TechnicalAnalysisRequest }))
        .rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST" } });
    }
  });

  it("Volume Profile full-series 응답을 최대 20,000개 봉으로 제한한다", async () => {
    const oversized = series("AAA", 100, [100, 200]);
    const template = oversized.points[0]!;
    oversized.points = Array.from({ length: 20_001 }, (_, index) => {
      const date = new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10);
      return { ...template, date, periodStart: date, periodEnd: date, volume: 100 };
    });
    const { service, rustCompute } = await harness({ getPriceSeries: async () => oversized });
    await expect(service.analyze({
      ownerSubject: "owner-a",
      request: {
        ...baseRequest,
        symbols: ["AAA"],
        indicators: [{ id: "profile", kind: "volume_profile" }],
      },
    })).rejects.toMatchObject({
      detail: {
        code: "TECHNICAL_VOLUME_PROFILE_OUTPUT_LIMIT",
        details: { observations: 20_001, maximum_observations: 20_000 },
      },
    });
    expect(rustCompute.compute).not.toHaveBeenCalled();
  });

  it("거래량 필요 여부를 지표 target 종목별로만 가격 계층에 전달한다", async () => {
    const { service, marketData } = await harness({ volumes: () => [100, 200] });
    await service.analyze({
      ownerSubject: "owner-a",
      request: {
        ...baseRequest,
        indicators: [{ id: "vwap", kind: "vwap_anchored_vwap", instrumentKeys: ["AAA"] }],
      },
    });
    expect(vi.mocked(marketData.getPriceSeries).mock.calls.map(([request]) => [request.symbol, request.requireVolume])).toEqual([
      ["AAA", true],
      ["BBB", false],
    ]);
  });

  it("latest-summary는 profile level을 보존하고 bucket 배열만 제거한다", () => {
    const projected = projectTechnicalAnalysisLatest({
      schema_version: "technical-analysis-result/v1",
      indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
      response_mode: "full_series",
      calculations: [{
        instrument_key: "AAA",
        points: [{ date: "2024-01-03", state: "available", values: { point_of_control: 101 } }],
        metadata: { approximate: true },
        profile: { point_of_control: 101, value_area_high: 105, value_area_low: 95, buckets: [{ index: 0 }, { index: 1 }] },
      }],
    });
    expect(projected).toMatchObject({
      response_mode: "latest_summary",
      calculations: [{
        latest: { date: "2024-01-03" },
        metadata: { approximate: true, profile_buckets: "omitted_in_latest_summary" },
        profile: { point_of_control: 101, value_area_high: 105, value_area_low: 95, buckets: [] },
      }],
    });
  });

  it("Rust가 profile bucket 상한을 위반하면 결과를 저장하기 전에 거부한다", async () => {
    const { service } = await harness({ profileBucketCount: 201 });
    await expect(service.analyze({ ownerSubject: "owner-a", request: baseRequest }))
      .rejects.toMatchObject({ detail: { code: "TECHNICAL_VOLUME_PROFILE_OUTPUT_LIMIT" } });
  });

  it("모든 종목과 지표를 정렬한 단일 Rust batch로 계산하고 artifact를 노출한다", async () => {
    const { service, marketData, runRepository, rustCompute } = await harness();
    const response = await service.analyze({ ownerSubject: "owner-a", request: baseRequest });

    expect(marketData.getPriceSeries).toHaveBeenCalledTimes(2);
    expect(rustCompute.compute).toHaveBeenCalledTimes(1);
    const [kind, payload, options] = vi.mocked(rustCompute.compute).mock.calls[0] as unknown as [
      string,
      TechnicalAnalysisWorkerPayload,
      { includeArtifacts: boolean },
    ];
    expect(kind).toBe("technical_analysis");
    expect(options.includeArtifacts).toBe(true);
    expect(payload.technical_analysis).toMatchObject({
      schema_version: "technical-analysis-request/v1",
      response_mode: "full_series",
      adjustment_policy: "adjusted",
    });
    expect(payload.technical_analysis.instruments.map((item) => item.key)).toEqual(["AAA", "BBB"]);
    expect(payload.technical_analysis.instruments[0]?.bars[0]?.volume).toBeNull();
    expect(payload.technical_analysis.indicators.map((item) => item.id)).toEqual(["rsi-main", "sma-main"]);
    expect(payload.technical_analysis.indicators[1]?.instrument_keys).toBeUndefined();
    expect(resultOf(response)).toMatchObject({
      reused: false,
      response_mode: "full_series",
      technical_analysis: {
        response_mode: "full_series",
        calculations: [expect.objectContaining({ instrument_key: "AAA", indicator_id: "sma-main" })],
      },
      artifact_index: expect.arrayContaining([
        expect.objectContaining({
          type: "technical-indicators",
          uri: expect.stringContaining("/artifacts/technical-indicators"),
        }),
        expect.objectContaining({
          type: "worker-metrics",
          uri: expect.stringContaining("/artifacts/worker-metrics"),
        }),
      ]),
    });
    const stored = await runRepository.get(String(resultOf(response).run_id), "owner-a");
    expect(stored?.input).toMatchObject({
      indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
      symbols: ["AAA", "BBB"],
      indicators: [
        { id: "rsi-main", kind: "rsi" },
        { id: "sma-main", kind: "sma" },
      ],
    });
    expect(stored?.input).not.toHaveProperty("responseMode");
  });

  it("responseMode와 입력 순서가 달라도 같은 영구 cache를 쓰고 latest summary만 투영한다", async () => {
    const { service, rustCompute } = await harness();
    const full = await service.analyze({ ownerSubject: "owner-a", request: baseRequest });
    const latest = await service.analyze({
      ownerSubject: "owner-a",
      request: {
        ...baseRequest,
        symbols: ["AAA", "BBB"],
        responseMode: "latest_summary",
        indicators: [...baseRequest.indicators].reverse().map(({ instrumentKeys: _allTargets, ...indicator }) => indicator),
      },
    });

    expect(rustCompute.compute).toHaveBeenCalledTimes(1);
    const fullResult = resultOf(full);
    const latestResult = resultOf(latest);
    expect(latestResult).toMatchObject({
      run_id: resultOf(full).run_id,
      reused: true,
      response_mode: "latest_summary",
      technical_analysis: {
        response_mode: "latest_summary",
        calculations: [{
          instrument_key: "AAA",
          indicator_id: "sma-main",
          latest: { date: "2024-01-03", state: "available", values: { sma: 102 } },
        }],
      },
    });
    expect((fullResult.price_series as Array<{ bars: unknown[] }>).map((item) => item.bars.length)).toEqual([2, 2]);
    expect((latestResult.price_series as Array<{ bars: unknown[] }>).map((item) => item.bars.length)).toEqual([1, 1]);
    const fullCalculation = (fullResult.technical_analysis as { calculations: Array<Record<string, unknown>> }).calculations[0]!;
    const latestCalculation = (latestResult.technical_analysis as { calculations: Array<Record<string, unknown>> }).calculations[0]!;
    expect(fullCalculation.points).toHaveLength(2);
    expect(fullCalculation).not.toHaveProperty("latest");
    expect(latestCalculation).not.toHaveProperty("points");
    expect(latestResult.technical_analysis).not.toEqual({ calculation_count: 1 });
  });

  it("내부 replay nonce는 동일 설정·data revision에서도 fresh run을 만든다", async () => {
    const { service, rustCompute } = await harness();
    const original = await service.analyze({ ownerSubject: "owner-a", request: baseRequest });
    const replay = await service.analyze({
      ownerSubject: "owner-a",
      request: baseRequest,
      cacheNonce: "00000000-0000-4000-8000-000000000001",
    });

    expect(resultOf(replay).run_id).not.toBe(resultOf(original).run_id);
    expect(rustCompute.compute).toHaveBeenCalledTimes(2);
  });

  it("빈 목록과 정규화 후 중복 symbol·indicator id를 worker 호출 전에 거부한다", async () => {
    const { service, marketData, rustCompute } = await harness();
    await expect(service.analyze({ ownerSubject: "owner-a", request: { ...baseRequest, symbols: [] } }))
      .rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST", field: "symbols" } });
    await expect(service.analyze({ ownerSubject: "owner-a", request: { ...baseRequest, symbols: ["aaa", "AAA"] } }))
      .rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST", field: "symbols" } });
    await expect(service.analyze({
      ownerSubject: "owner-a",
      request: { ...baseRequest, indicators: [{ id: "same", kind: "sma" }, { id: "same", kind: "ema" }] },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST", field: "indicators" } });
    await expect(service.analyze({
      ownerSubject: "owner-a",
      request: { ...baseRequest, indicators: [{ id: "unknown", kind: "not_an_indicator" as never }] },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST", field: "indicators.0.kind" } });
    expect(marketData.getPriceSeries).not.toHaveBeenCalled();
    expect(rustCompute.compute).not.toHaveBeenCalled();
  });

  it("지표 parameter의 이름·범위·교차 조건·instrument key를 가격 조회 전에 4xx validation으로 거부한다", async () => {
    const { service, marketData, rustCompute } = await harness();
    const invalidIndicators: TechnicalAnalysisRequest["indicators"][] = [
      [{ id: "zero-period", kind: "sma", parameters: { period: 0 } }],
      [{ id: "fractional-period", kind: "adx_dmi", parameters: { period: 2.5 } }],
      [{ id: "unknown-parameter", kind: "cci", parameters: { mystery: 1 } }],
      [{ id: "bad-enum", kind: "historical_volatility", parameters: { return_type: "geometric" } }],
      [{ id: "bad-macd", kind: "macd", parameters: { fast_period: 30 } }],
      [{ id: "bad-sar", kind: "parabolic_sar", parameters: { step: 0.3, max_step: 0.2 } }],
      [{ id: "missing-benchmark", kind: "benchmark_relative_strength" }],
      [{ id: "unknown-benchmark", kind: "benchmark_relative_strength", parameters: { benchmark_key: "MISSING" } }],
    ];

    for (const indicators of invalidIndicators) {
      await expect(service.analyze({
        ownerSubject: "owner-a",
        request: { ...baseRequest, indicators },
      })).rejects.toMatchObject({
        detail: { code: "INVALID_TECHNICAL_ANALYSIS_REQUEST" },
      });
    }
    expect(marketData.getPriceSeries).not.toHaveBeenCalled();
    expect(rustCompute.compute).not.toHaveBeenCalled();
  });

  it("정렬된 OHLCV 내용이 바뀌면 data revision과 cache run을 갱신한다", async () => {
    let price = 100;
    const { service, rustCompute } = await harness({ price: () => price });
    const first = await service.analyze({ ownerSubject: "owner-a", request: baseRequest });
    price = 120;
    const second = await service.analyze({ ownerSubject: "owner-a", request: baseRequest });

    expect((first as { data_revision: string }).data_revision).not.toBe((second as { data_revision: string }).data_revision);
    expect(resultOf(first).run_id).not.toBe(resultOf(second).run_id);
    expect(rustCompute.compute).toHaveBeenCalledTimes(2);
  });

  it("합계가 같은 volume 분포 변경도 canonical OHLCV revision과 cache run을 갱신한다", async () => {
    let volumes: readonly [number | null, number | null] = [100, 200];
    const { service, rustCompute } = await harness({ volumes: () => volumes });
    const request: TechnicalAnalysisRequest = {
      ...baseRequest,
      symbols: ["AAA"],
      indicators: [{ id: "volume-main", kind: "volume_sma", parameters: { period: 2 } }],
    };
    const first = await service.analyze({ ownerSubject: "owner-a", request });
    volumes = [150, 150];
    const second = await service.analyze({ ownerSubject: "owner-a", request });

    expect((first as { data_revision: string }).data_revision).not.toBe((second as { data_revision: string }).data_revision);
    expect(resultOf(first).run_id).not.toBe(resultOf(second).run_id);
    expect(rustCompute.compute).toHaveBeenCalledTimes(2);
  });

  it("일봉 signal safe date는 이미 준비한 종목별 실제 관측일의 교집합을 추가 조회 없이 사용한다", async () => {
    const { service, marketData } = await harness({
      getPriceSeries: async ({ symbol }) => {
        const base = series(symbol, 100);
        const dates = symbol === "AAA"
          ? ["2024-01-01", "2024-01-02", "2024-01-03"]
          : ["2024-01-02", "2024-01-03", "2024-01-04"];
        return {
          ...base,
          points: dates.map((date, index) => ({ ...base.points[0]!, date, periodStart: date, periodEnd: date, close: 100 + index })),
          effectivePeriod: { from: dates[0]!, to: dates.at(-1)! },
        };
      },
    });
    const prepared = await service.prepare({ ...baseRequest, symbols: ["AAA", "BBB"] });

    await expect(service.safeTradeDates(prepared)).resolves.toEqual(["2024-01-02", "2024-01-03"]);
    expect(marketData.getPriceSeries).toHaveBeenCalledTimes(2);
  });

  it("주봉 signal은 미래 적용일에 주봉 label을 쓰지 않고 별도 일봉 실제 관측 교집합을 조회한다", async () => {
    const { service, marketData } = await harness({
      getPriceSeries: async ({ symbol, interval }) => {
        const base = series(symbol, 100);
        const dates = interval === "1w"
          ? ["2024-01-05", "2024-01-12"]
          : symbol === "AAA"
            ? ["2024-01-01", "2024-01-02", "2024-01-03"]
            : ["2024-01-02", "2024-01-03", "2024-01-04"];
        return {
          ...base,
          interval,
          points: dates.map((date, index) => ({ ...base.points[0]!, date, periodStart: date, periodEnd: date, close: 100 + index })),
          effectivePeriod: { from: dates[0]!, to: dates.at(-1)! },
        } as MarketSeriesResult;
      },
    });
    const prepared = await service.prepare({ ...baseRequest, symbols: ["AAA", "BBB"], interval: "1w" });

    await expect(service.safeTradeDates(prepared)).resolves.toEqual(["2024-01-02", "2024-01-03"]);
    expect(vi.mocked(marketData.getPriceSeries).mock.calls.map(([input]) => input.interval)).toEqual(["1w", "1w", "1d", "1d"]);
  });

  it("inline 모드에서는 가격 조회 전에 Rust 전용 오류를 반환한다", async () => {
    const { service, marketData } = await harness({ executionMode: "inline" });
    await expect(service.analyze({ ownerSubject: "owner-a", request: baseRequest }))
      .rejects.toMatchObject({ detail: { code: "RUST_COMPUTE_REQUIRED" } });
    expect(marketData.getPriceSeries).not.toHaveBeenCalled();
  });

  it("등록되지 않은 worker artifact는 저장하지 않고 명확히 거부한다", async () => {
    const { service } = await harness({ unknownArtifact: true });
    await expect(service.analyze({ ownerSubject: "owner-a", request: baseRequest }))
      .rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ARTIFACT" } });
  });

  it("worker의 technical artifact와 canonical result가 다르면 저장 전에 거부한다", async () => {
    const { service } = await harness({ mismatchedArtifact: true });
    await expect(service.analyze({ ownerSubject: "owner-a", request: baseRequest }))
      .rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_ARTIFACT" } });
  });

  it("Rust 결과의 지표 엔진 버전이 cache mirror와 다르면 저장 전에 실패한다", async () => {
    const { service } = await harness({ engineVersion: "technical-indicators/old" });
    await expect(service.analyze({ ownerSubject: "owner-a", request: baseRequest }))
      .rejects.toMatchObject({
        detail: {
          code: "TECHNICAL_INDICATOR_ENGINE_VERSION_MISMATCH",
          details: {
            expected: TECHNICAL_INDICATOR_ENGINE_VERSION,
            actual: "technical-indicators/old",
          },
        },
      });
  });
});
