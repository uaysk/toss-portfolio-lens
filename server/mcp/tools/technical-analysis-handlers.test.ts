import { describe, expect, it, vi } from "vitest";
import { envelope } from "../../services/service-envelope.js";
import {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_KINDS,
} from "../../services/technical-analysis-service.js";
import { toolSchemas } from "../schemas.js";
import { createToolHandlers, type McpToolDependencies } from "./handlers.js";

const request = {
  symbols: ["bbb", "AAA"],
  fromDate: "2024-01-01",
  toDate: "2024-12-31",
  interval: "1w",
  adjusted: true,
  currencyMode: "KRW",
  responseMode: "full_series",
  indicators: [{ id: "position-main", kind: "fifty_two_week_high_low_position", instrumentKeys: ["AAA"] }],
} as const;

const stageTwoPriceIndicators = [
  { id: "sma-5", kind: "sma", parameters: { period: 5, source: "close" } },
  { id: "ema-5", kind: "ema", parameters: { period: 5, source: "close" } },
  { id: "rsi-5", kind: "rsi", parameters: { period: 5, source: "close" } },
  { id: "macd-3-6-2", kind: "macd", parameters: { fast_period: 3, slow_period: 6, signal_period: 2, source: "close" } },
  { id: "bollinger-5", kind: "bollinger_bands", parameters: { period: 5, stddev_multiplier: 2, source: "close" } },
  { id: "atr-5", kind: "atr", parameters: { period: 5 } },
  { id: "donchian-5", kind: "donchian_channel", parameters: { period: 5 } },
  { id: "relative-to-bbb", kind: "benchmark_relative_strength", parameters: { benchmark_key: "BBB" } },
  { id: "high-low-position-10", kind: "fifty_two_week_high_low_position", parameters: { period: 10 } },
  { id: "ma-distance-5", kind: "moving_average_distance", parameters: { period: 5, average_type: "ema", source: "close" } },
  { id: "adx-dmi-5", kind: "adx_dmi", parameters: { period: 5 } },
  { id: "stochastic-5-2-2", kind: "stochastic_oscillator", parameters: { lookback_period: 5, smooth_k: 2, smooth_d: 2 } },
  { id: "roc-5", kind: "roc", parameters: { period: 5, source: "close" } },
  { id: "keltner-5", kind: "keltner_channel", parameters: { ema_period: 5, atr_period: 5, multiplier: 2 } },
  { id: "supertrend-5", kind: "supertrend", parameters: { atr_period: 5, multiplier: 2 } },
  { id: "historical-volatility-5", kind: "historical_volatility", parameters: { period: 5, annualization: 252, return_type: "log" } },
  { id: "normalized-atr-5", kind: "normalized_atr", parameters: { period: 5 } },
  { id: "bollinger-width-percent-b-5", kind: "bollinger_band_width_percent_b", parameters: { period: 5, stddev_multiplier: 2, source: "close" } },
  { id: "aroon-5", kind: "aroon", parameters: { period: 5 } },
  { id: "cci-5", kind: "cci", parameters: { period: 5, constant: 0.015 } },
  { id: "williams-r-5", kind: "williams_r", parameters: { period: 5 } },
  { id: "parabolic-sar", kind: "parabolic_sar", parameters: { step: 0.02, max_step: 0.2 } },
  { id: "choppiness-5", kind: "choppiness_index", parameters: { period: 5 } },
] as const;

describe("technical analysis common HTTP/MCP handler", () => {
  it("HTTP dispatcher와 MCP가 동일 schema·service handler 결과를 사용한다", async () => {
    const response = envelope({
      request,
      dataRevision: "technical-revision",
      result: {
        run_id: "00000000-0000-4000-8000-000000000101",
        reused: false,
        response_mode: "full_series",
        price_series: [],
        technical_analysis: { calculations: [] },
        artifact_index: [],
      },
    });
    const technicalAnalysis = { analyze: vi.fn().mockResolvedValue(response) };
    const handlers = createToolHandlers({ technicalAnalysis } as unknown as McpToolDependencies);
    const invokeCommonDispatcher = (body: unknown, ownerSubject: string) => {
      const parsed = toolSchemas.analyze_technical_signals.parse(body);
      return handlers.analyze_technical_signals(parsed, ownerSubject);
    };

    const http = await invokeCommonDispatcher(request, "owner-a");
    const mcp = await invokeCommonDispatcher(request, "owner-a");

    expect(http).toEqual(mcp);
    expect(technicalAnalysis.analyze).toHaveBeenCalledTimes(2);
    expect(technicalAnalysis.analyze).toHaveBeenNthCalledWith(1, {
      ownerSubject: "owner-a",
      request: expect.objectContaining({
        symbols: ["BBB", "AAA"],
        interval: "1w",
        responseMode: "full_series",
        indicators: [{ id: "position-main", kind: "fifty_two_week_high_low_position", instrumentKeys: ["AAA"] }],
      }),
    });
  });

  it("1~2단계 가격 지표 23개를 HTTP와 MCP에서 같은 공통 service batch로 전달한다", async () => {
    expect(stageTwoPriceIndicators.map(({ kind }) => kind)).toEqual(TECHNICAL_INDICATOR_KINDS.slice(0, 23));
    const batchRequest = {
      ...request,
      interval: "1d",
      indicators: stageTwoPriceIndicators,
    } as const;
    const response = envelope({
      request: batchRequest,
      dataRevision: "technical-stage-two-revision",
      result: {
        run_id: "00000000-0000-4000-8000-000000000102",
        reused: false,
        response_mode: "full_series",
        price_series: [],
        technical_analysis: { calculations: [] },
        artifact_index: [],
      },
    });
    const technicalAnalysis = { analyze: vi.fn().mockResolvedValue(response) };
    const handlers = createToolHandlers({ technicalAnalysis } as unknown as McpToolDependencies);
    const invokeCommonDispatcher = (body: unknown) => {
      const parsed = toolSchemas.analyze_technical_signals.parse(body);
      return handlers.analyze_technical_signals(parsed, "owner-a");
    };

    const http = await invokeCommonDispatcher(batchRequest);
    const mcp = await invokeCommonDispatcher(batchRequest);

    expect(http).toEqual(mcp);
    expect(technicalAnalysis.analyze).toHaveBeenCalledTimes(2);
    for (const [call] of technicalAnalysis.analyze.mock.calls) {
      expect(call).toEqual(expect.objectContaining({
        ownerSubject: "owner-a",
        request: expect.objectContaining({
          symbols: ["BBB", "AAA"],
          interval: "1d",
          indicators: stageTwoPriceIndicators,
        }),
      }));
    }
  });

  it("Stage 4 VWAP batch와 focused Volume Profile을 HTTP·MCP에서 동일한 service 계약으로 전달한다", async () => {
    const technicalAnalysis = {
      analyze: vi.fn().mockImplementation(({ request: analyzedRequest }) => Promise.resolve(envelope({
        request: analyzedRequest,
        dataRevision: "technical-stage-four-revision",
        result: { request: analyzedRequest },
      }))),
    };
    const handlers = createToolHandlers({ technicalAnalysis } as unknown as McpToolDependencies);
    const invoke = (body: unknown) => handlers.analyze_technical_signals(
      toolSchemas.analyze_technical_signals.parse(body),
      "owner-a",
    );
    const vwap = {
      ...request,
      indicators: [{
        id: "vwap-main",
        kind: "vwap_anchored_vwap",
        parameters: { anchor: "signal_date", anchor_date: "2024-06-03", lookback_period: 20, mode: "both" },
      }],
    } as const;
    const profile = {
      ...request,
      symbols: ["AAA"],
      indicators: [{
        id: "profile-focused",
        kind: "volume_profile",
        parameters: { bucket_count: 24, price_source: "typical_price", value_area_percent: 70 },
        instrumentKeys: ["AAA"],
      }],
    } as const;

    expect((await invoke(vwap) as { result: unknown }).result).toEqual((await invoke(vwap) as { result: unknown }).result);
    expect((await invoke(profile) as { result: unknown }).result).toEqual((await invoke(profile) as { result: unknown }).result);
    expect(technicalAnalysis.analyze).toHaveBeenCalledTimes(4);
    expect(technicalAnalysis.analyze).toHaveBeenNthCalledWith(1, {
      ownerSubject: "owner-a",
      request: expect.objectContaining({ indicators: vwap.indicators }),
    });
    expect(technicalAnalysis.analyze).toHaveBeenNthCalledWith(3, {
      ownerSubject: "owner-a",
      request: expect.objectContaining({ symbols: ["AAA"], indicators: profile.indicators }),
    });
  });

  it("strict schema 오류는 공통 handler와 worker service 호출 전에 거부한다", async () => {
    const technicalAnalysis = { analyze: vi.fn() };
    const handlers = createToolHandlers({ technicalAnalysis } as unknown as McpToolDependencies);
    const invokeCommonDispatcher = async (body: unknown) => {
      const parsed = toolSchemas.analyze_technical_signals.parse(body);
      return handlers.analyze_technical_signals(parsed, "owner-a");
    };

    await expect(invokeCommonDispatcher({ ...request, indicators: [{ id: "bad", kind: "not_an_indicator" }] }))
      .rejects.toThrow();
    await expect(invokeCommonDispatcher({ ...request, unexpected: true })).rejects.toThrow();
    expect(technicalAnalysis.analyze).not.toHaveBeenCalled();
  });

  it("technical_analysis 저장 입력을 공개 tool 입력으로 복원해 fresh replay에 전달한다", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000201";
    const replayId = "00000000-0000-4000-8000-000000000202";
    const storedInput = {
      cacheSchemaVersion: "technical-analysis-cache/v1",
      indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
      symbols: ["AAA", "BBB"],
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      interval: "1d",
      adjusted: true,
      currencyMode: "KRW",
      indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 }, instrumentKeys: ["AAA"] }],
    };
    const source = {
      id: sourceId,
      kind: "technical_analysis",
      ownerSubject: "owner-a",
      status: "completed",
      input: storedInput,
      name: "기술 분석",
      tags: ["technical"],
      warnings: [],
      dataRevision: "revision-a",
    };
    const replay = { ...source, id: replayId, name: "기술 분석 재실행", replayOf: sourceId };
    const technicalAnalysis = {
      analyze: vi.fn().mockResolvedValue({ result: { run_id: replayId } }),
    };
    const runRepository = {
      get: vi.fn().mockImplementation((id: string) => Promise.resolve(id === sourceId ? source : id === replayId ? replay : undefined)),
      rename: vi.fn().mockResolvedValue(replay),
      setTags: vi.fn().mockResolvedValue(replay),
      linkReplay: vi.fn().mockResolvedValue(true),
    };
    const handlers = createToolHandlers({ technicalAnalysis, runRepository } as unknown as McpToolDependencies);

    const response = await handlers.rerun_run({ runId: sourceId }, "owner-a");

    expect(response).toMatchObject({ result: { run: { id: replayId }, replay_of: sourceId } });
    expect(technicalAnalysis.analyze).toHaveBeenCalledOnce();
    const replayCall = technicalAnalysis.analyze.mock.calls[0]![0] as {
      ownerSubject: string;
      request: Record<string, unknown>;
      cacheNonce: string;
    };
    expect(replayCall.ownerSubject).toBe("owner-a");
    expect(replayCall.cacheNonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(replayCall.request).toMatchObject({
      symbols: ["AAA", "BBB"],
      responseMode: "full_series",
      indicators: [{ id: "sma-main", kind: "sma", instrumentKeys: ["AAA"] }],
    });
    expect(toolSchemas.analyze_technical_signals.safeParse(replayCall.request).success).toBe(true);
    expect(replayCall.request).not.toHaveProperty("cacheSchemaVersion");
    expect(replayCall.request).not.toHaveProperty("indicator_engine_version");
    expect(runRepository.linkReplay).toHaveBeenCalledWith(replayId, "owner-a", sourceId);
  });

  it("신호 분석·검증·결합 백테스트의 HTTP와 MCP가 같은 technical strategy service를 사용한다", async () => {
    const analysis = {
      symbols: ["AAA"], fromDate: "2023-01-01", toDate: "2024-12-31", interval: "1d",
      adjusted: true, currencyMode: "KRW", responseMode: "full_series",
      indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 } }],
    } as const;
    const strategy = {
      schemaVersion: "technical-strategy/v1", id: "trend-main",
      entryCondition: {
        operator: "crosses_above",
        left: { type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "value" },
        right: { type: "constant", value: 10 },
      },
      exitCondition: {
        operator: "less_than",
        left: { type: "bar", instrumentKey: "AAA", field: "close" },
        right: { type: "constant", value: 8 },
      },
      minimumHoldingPeriod: 0, cooldownPeriod: 0, initialState: "inactive",
      allocations: {
        active: { weights: { AAA: 100 }, cashPercent: 0 },
        inactive: { weights: { AAA: 0 }, cashPercent: 100 },
      },
    } as const;
    const combined = {
      analysis,
      strategy,
      backtest: {
        assets: [{ symbol: "AAA", weight: 0 }], startDate: "2024-01-01", endDate: "2024-12-31",
        initialAmount: 1_000_000, monthlyCashFlow: 0, rebalanceFrequency: "none", benchmark: "NONE",
        currencyMode: "KRW", execution: { cashTargetPercent: 100 },
      },
    } as const;
    const signalResponse = envelope({ request: { analysis, strategy }, dataRevision: "signals", result: { run_id: "signal-run" } });
    const validationResponse = envelope({ request: combined, dataRevision: "validation", result: { valid: true } });
    const backtestResponse = envelope({ request: combined, dataRevision: "strategy-run", result: { run_id: "strategy-run" } });
    const technicalStrategies = {
      analyzeSignals: vi.fn().mockResolvedValue(signalResponse),
      validate: vi.fn().mockResolvedValue(validationResponse),
      runBacktest: vi.fn().mockResolvedValue(backtestResponse),
    };
    const handlers = createToolHandlers({ technicalStrategies, maxAssets: 20, maxDateRangeYears: 20 } as unknown as McpToolDependencies);
    const invoke = (tool: "analyze_technical_signals" | "validate_technical_strategy" | "run_technical_strategy_backtest", body: unknown) => (
      handlers[tool](toolSchemas[tool].parse(body), "owner-a")
    );

    expect(await invoke("analyze_technical_signals", { analysis, strategy }))
      .toEqual(await invoke("analyze_technical_signals", { analysis, strategy }));
    expect(await invoke("validate_technical_strategy", combined)).toEqual(validationResponse);
    expect(await invoke("run_technical_strategy_backtest", combined)).toEqual(backtestResponse);
    expect(technicalStrategies.analyzeSignals).toHaveBeenCalledTimes(2);
    expect(technicalStrategies.validate).toHaveBeenCalledWith({ ownerSubject: "owner-a", request: expect.objectContaining({ analysis, strategy }) });
    expect(technicalStrategies.runBacktest).toHaveBeenCalledWith({ ownerSubject: "owner-a", request: expect.objectContaining({ analysis, strategy }) });
  });

  it("signal-only technical_strategy 저장 입력을 공개 신호 요청으로 복원해 fresh replay한다", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000301";
    const replayId = "00000000-0000-4000-8000-000000000302";
    const storedInput = {
      cacheSchemaVersion: "technical-strategy-cache/v1",
      indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
      mode: "signal_only",
      analysis: {
        symbols: ["AAA"], fromDate: "2023-01-01", toDate: "2024-12-31", interval: "1d",
        adjusted: true, currencyMode: "KRW", responseMode: "full_series",
        indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 } }],
      },
      strategy: {
        schemaVersion: "technical-strategy/v1", id: "trend-main",
        entryCondition: { operator: "greater_than", left: { type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "value" }, right: { type: "constant", value: 10 } },
        exitCondition: { operator: "less_than", left: { type: "bar", instrumentKey: "AAA", field: "close" }, right: { type: "constant", value: 8 } },
        minimumHoldingPeriod: 0, cooldownPeriod: 0, initialState: "inactive",
        allocations: { active: { weights: { AAA: 100 }, cashPercent: 0 }, inactive: { weights: { AAA: 0 }, cashPercent: 100 } },
      },
    };
    const source = {
      id: sourceId, kind: "technical_strategy", ownerSubject: "owner-a", status: "completed", input: storedInput,
      name: "신호 전략", tags: ["signal"], warnings: [], dataRevision: "revision-a",
    };
    const replay = { ...source, id: replayId, replayOf: sourceId };
    const technicalStrategies = { analyzeSignals: vi.fn().mockResolvedValue({ result: { run_id: replayId } }) };
    const runRepository = {
      get: vi.fn().mockImplementation((id: string) => Promise.resolve(id === sourceId ? source : id === replayId ? replay : undefined)),
      rename: vi.fn().mockResolvedValue(replay), setTags: vi.fn().mockResolvedValue(replay), linkReplay: vi.fn().mockResolvedValue(true),
    };
    const handlers = createToolHandlers({
      technicalStrategies, runRepository, maxAssets: 20, maxDateRangeYears: 20,
    } as unknown as McpToolDependencies);

    const response = await handlers.rerun_run({ runId: sourceId }, "owner-a");

    expect(response).toMatchObject({ result: { run: { id: replayId }, replay_of: sourceId } });
    expect(technicalStrategies.analyzeSignals).toHaveBeenCalledOnce();
    expect(technicalStrategies.analyzeSignals.mock.calls[0]![0]).toMatchObject({
      ownerSubject: "owner-a",
      request: { analysis: { symbols: ["AAA"] }, strategy: { id: "trend-main" } },
      cacheNonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});
