import { describe, expect, it } from "vitest";
import {
  AI_SIMULATION_PAIR_CATALOG,
  DEFAULT_AI_SIMULATION_REQUEST,
  aiSimulationErrorMessage,
  normalizeAiSimulationHistory,
  normalizeAiSimulationReport,
  normalizeAiSimulationRun,
  normalizeAiSimulationSnapshot,
  normalizeAiSimulationStatus,
  validateAiSimulationRequest,
  type AiSimulationRequest,
} from "./ai-simulation";

describe("AI simulation request validation", () => {
  it("defaults to the backward-compatible single strategy", () => {
    expect(DEFAULT_AI_SIMULATION_REQUEST.strategy).toEqual({ mode: "single" });
    expect(AI_SIMULATION_PAIR_CATALOG.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "soxx-soxl-soxs", label: "SOXX · SOXL · SOXS" },
      { id: "smh-soxl-soxs", label: "SMH · SOXL · SOXS" },
      { id: "tsla-tsll-tsls", label: "TSLA · TSLL · TSLS" },
      { id: "tsla-tsll-tslq", label: "TSLA · TSLL · TSLQ" },
      { id: "qqq-tqqq-sqqq", label: "QQQ · TQQQ · SQQQ" },
    ]);
  });

  it("accepts both markets, all presets, and one or two AI-selected symbols", () => {
    for (const marketCountry of ["KR", "US"] as const) {
      for (const symbolCount of [1, 2] as const) {
        expect(validateAiSimulationRequest({
          ...DEFAULT_AI_SIMULATION_REQUEST,
          marketCountry,
          selection: {
            mode: "auto",
            criterion: "trading_amount",
            symbolCount,
          },
        })).toEqual([]);
      }
    }
  });

  it("accepts one or two normalized manual symbols and rejects duplicates", () => {
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      selection: { mode: "manual", symbols: ["005930", "000660"] },
    })).toEqual([]);
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      selection: { mode: "manual", symbols: ["NVDA", "nvda"] },
    })).toContain("직접 선택 종목은 중복될 수 없습니다.");
  });

  it("applies server-provided cash and duration limits without inventing values", () => {
    const limits = {
      minimumInitialCash: 100_000,
      maximumInitialCash: 20_000_000,
      minimumDurationMinutes: 15,
      maximumDurationMinutes: 240,
    };
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      durationMinutes: 15,
    }, limits)).toEqual([]);
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      initialCash: 50_000,
      durationMinutes: 241,
    }, limits)).toEqual([
      "예수금은 100000 이상이어야 합니다.",
      "테스트 기간은 240분 이하여야 합니다.",
    ]);
  });

  it("rejects unsupported modes, fractional periods, and invalid costs", () => {
    const invalid = {
      ...DEFAULT_AI_SIMULATION_REQUEST,
      marketCountry: "JP",
      durationMinutes: 12.5,
      riskTolerance: 101,
      selection: {
        mode: "auto",
        criterion: "market_cap",
        symbolCount: 3,
      },
      preset: "guaranteed_profit",
      costs: { ...DEFAULT_AI_SIMULATION_REQUEST.costs, slippageBpsPerSide: -1 },
    } as unknown as AiSimulationRequest;
    expect(validateAiSimulationRequest(invalid)).toEqual(expect.arrayContaining([
      "시장 선택이 올바르지 않습니다.",
      "종목 선정 기준이 올바르지 않습니다.",
      "AI 전략 프리셋이 올바르지 않습니다.",
      "공격·방어 성향은 0부터 100 사이의 정수여야 합니다.",
      "테스트 기간은 1분 이상의 정수여야 합니다.",
      "AI 선정 종목 수는 1개 또는 2개여야 합니다.",
      "편도 슬리피지 bps는 0 이상의 숫자여야 합니다.",
    ]));
  });

  it("accepts catalogued US pair strategies and rejects pair mode outside US", () => {
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      marketCountry: "US",
      strategy: {
        mode: "pair",
        pairId: "tsla-tsll-tslq",
        allowDegradedMode: false,
      },
    })).toEqual([]);
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: true,
      },
    })).toContain("페어 전략은 미국 시장에서만 실행할 수 있습니다.");
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      marketCountry: "US",
      strategy: {
        mode: "pair",
        pairId: "not-catalogued",
        allowDegradedMode: false,
      },
    } as unknown as AiSimulationRequest)).toContain("페어 전략 카탈로그를 확인해 주세요.");
  });
});

describe("AI simulation response normalization", () => {
  it("reads nested runtime limits and preserves explicit disabled status", () => {
    expect(normalizeAiSimulationStatus({
      enabled: false,
      reason: "AI worker unavailable",
      limits: {
        initialCash: { min: 100_000, max: 50_000_000 },
        durationMinutes: { minimum: 10, maximum: 390 },
      },
      capabilities: { realOrders: false, mcp: false, symbolCountMaximum: 2 },
      limitations: ["실시간 데이터가 없으면 시작할 수 없습니다."],
    })).toEqual({
      enabled: false,
      message: "AI worker unavailable",
      limits: {
        minimumInitialCash: 100_000,
        maximumInitialCash: 50_000_000,
        minimumDurationMinutes: 10,
        maximumDurationMinutes: 390,
      },
      capabilities: { realOrders: false, mcp: false, symbolCountMaximum: 2 },
      limitations: ["실시간 데이터가 없으면 시작할 수 없습니다."],
    });
  });

  it("normalizes pair capability and server catalog while retaining static labels", () => {
    const status = normalizeAiSimulationStatus({
      enabled: true,
      capabilities: { pairStrategy: true },
      pairStrategy: {
        enabled: true,
        pairs: [{
          pair_id: "smh-soxl-soxs",
          signal_symbol: "SMH",
          bull: { execution_symbol: "SOXL" },
          bear: { execution_symbol: "SOXS" },
        }],
      },
    });
    expect(status.pairStrategy).toMatchObject({
      enabled: true,
      catalog: [{
        id: "smh-soxl-soxs",
        label: AI_SIMULATION_PAIR_CATALOG[1].label,
        symbols: ["SMH", "SOXL", "SOXS"],
      }],
    });
  });

  it("normalizes a causal snapshot and drops incomplete ledger entries", () => {
    const snapshot = normalizeAiSimulationSnapshot({
      phase: "monitoring",
      startedAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-24T01:00:00.000Z",
      marketCountry: "US",
      currency: "USD",
      initialCash: 10_000,
      cash: 4_990,
      equity: 10_120,
      progress: 0.5,
      selection: { mode: "manual", symbols: ["NVDA"] },
      preset: "trend",
      riskTolerance: 65,
      policyProfile: {
        entryUpProbability: 0.56,
        targetAllocationRate: 0.75,
        cashReserveRate: 0.25,
        technicalConfirmation: "non_exit",
        patternConfirmation: "non_bearish",
      },
      decisionCadence: {
        trigger: "finalized_one_minute_bar",
        triggeredEvents: 3,
      },
      selected: [
        {
          symbol: "NVDA",
          name: "NVIDIA",
          score: 0.82,
          upProbability: 0.61,
          predictedMedianReturn: 0.004,
          currentPrice: 171.25,
          priceObservedAt: "2026-07-24T00:01:12.345Z",
          model: { modelId: "chronos", modelRevision: "pinned", device: "cuda" },
        },
        { score: 1 },
      ],
      positions: [
        { symbol: "NVDA", quantity: 3, averagePrice: 170, marketPrice: 171, unrealizedPnl: 3 },
        { symbol: "BAD", averagePrice: 1 },
      ],
      trades: [
        { symbol: "NVDA", side: "buy", executedAt: "2026-07-24T00:02:00.000Z", price: 170, quantity: 3, amount: 510, cost: 0.4, source: "next_valid_quote" },
        { symbol: "BAD", side: "sell" },
      ],
      decisions: [
        {
          symbol: "NVDA",
          action: "buy",
          decidedAt: "2026-07-24T00:01:00.000Z",
          eligibleAfter: "2026-07-24T00:02:00.000Z",
          reason: "forecast_and_signal_aligned",
          reasons: ["forecast_positive", "technical_entry_candidate"],
          q10Return: -0.01,
          predictedMedianReturn: 0.006,
          q90Return: 0.02,
          technicalState: "entry_candidate",
          signalSymbol: "NVDA",
          executionSymbol: "NVDL",
          direction: "bull",
          degraded: false,
          components: { forecast: 0.7, technical: 0.3 },
          weights: { forecast: 0.6, technical: 0.4 },
          finalScores: { bull: 0.72, cash: 0.28 },
          provenance: [{ modelId: "chronos", revision: "pinned" }],
          chartPatternBias: "bullish",
          chartPatterns: ["bullish_engulfing"],
          model: "chronos",
        },
        { symbol: "BAD", action: "buy" },
      ],
      charts: [{
        symbol: "NVDA",
        name: "NVIDIA",
        currency: "USD",
        bars: [{
          timestamp: "2026-07-24T00:01:00.000Z",
          open: 169,
          high: 171,
          low: 168,
          close: 170,
          status: "final",
          indicatorValues: { "ema:value": 169.5 },
        }],
        indicators: [{ id: "ema", kind: "ema", status: "available", values: { value: 169.5 } }],
        patterns: [{
          name: "bullish_engulfing",
          bias: "bullish",
          detectedAt: "2026-07-24T00:01:00.000Z",
        }],
      }],
      warnings: ["호가 unavailable 구간은 다음 확정 분봉을 사용했습니다."],
      capabilities: { realOrders: false },
    });

    expect(snapshot).toMatchObject({
      phase: "monitoring",
      currency: "USD",
      progress: 0.5,
      selection: { mode: "manual", symbols: ["NVDA"] },
      preset: "trend",
      riskTolerance: 65,
      policyProfile: { targetAllocationRate: 0.75, cashReserveRate: 0.25 },
      decisionCadence: { trigger: "finalized_one_minute_bar", triggeredEvents: 3 },
      selected: [{
        symbol: "NVDA",
        currentPrice: 171.25,
        priceObservedAt: "2026-07-24T00:01:12.345Z",
        model: "chronos · pinned · CUDA",
      }],
      positions: [{ symbol: "NVDA", quantity: 3 }],
      trades: [{ symbol: "NVDA", source: "next_valid_quote" }],
      decisions: [{
        symbol: "NVDA",
        eligibleAfter: "2026-07-24T00:02:00.000Z",
        reasons: ["forecast_positive", "technical_entry_candidate"],
        q10Return: -0.01,
        predictedMedianReturn: 0.006,
        q90Return: 0.02,
        technicalState: "entry_candidate",
        signalSymbol: "NVDA",
        executionSymbol: "NVDL",
        direction: "bull",
        degraded: false,
        components: { forecast: 0.7, technical: 0.3 },
        weights: { forecast: 0.6, technical: 0.4 },
        finalScores: { bull: 0.72, cash: 0.28 },
        provenance: ["chronos · pinned"],
        chartPatterns: ["bullish_engulfing"],
      }],
      charts: [{ symbol: "NVDA", bars: [{ close: 170 }] }],
      capabilities: { realOrders: false },
    });
    expect(snapshot.selected).toHaveLength(1);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
  });

  it("normalizes snake-case four-lane comparisons and rejects malformed optional blocks", () => {
    const lanes = {
      chronos2: {
        status: "completed",
        analytical_only: true,
        cumulative_return: 0.012,
        net_return: 0.01,
        net_profit: 100,
        max_drawdown: 0.004,
        risk_adjusted_return: 1.4,
        trade_count: 4,
        total_costs: 2,
        transition_count: 2,
        direction_accuracy: 0.75,
        execution_selection_accuracy: 0.8,
        calibration: 0.09,
        unavailable_rate: 0,
        average_latency_ms: 42,
        bull_count: 3,
        bear_count: 1,
        cash_count: 5,
        decision_reasons: [{
          signal_symbol: "TSLA",
          execution_symbol: "TSLL",
          action: "bull",
          reasons: ["forecast_up", "execution_available"],
        }],
      },
      kronos_small: { status: "completed", cumulative_return: 0.009 },
      rust: { status: "completed", cumulative_return: 0.006 },
      ensemble: { status: "running", cumulative_return: 0.011 },
    };
    const snapshot = normalizeAiSimulationSnapshot({
      phase: "running",
      currency: "USD",
      initial_cash: 10_000,
      cash: 10_100,
      equity: 10_100,
      progress: 0.5,
      strategy_comparison: {
        condition_id: "condition-1",
        pair_id: "tsla-tsll-tslq",
        same_origin: true,
        same_costs: true,
        same_execution_policy: true,
        incomplete_count: 0,
        strategies: lanes,
      },
    });
    expect(snapshot.strategyComparison).toMatchObject({
      conditionId: "condition-1",
      pairId: "tsla-tsll-tslq",
      sameOrigin: true,
      sameCosts: true,
      sameExecutionPolicy: true,
      incompleteCount: 0,
      lanes: [
        {
          id: "chronos2",
          analyticalOnly: true,
          cumulativeReturn: 0.012,
          netReturn: 0.01,
          netProfit: 100,
          trades: 4,
          costs: 2,
          switches: 2,
          executionAccuracy: 0.8,
          latencyMs: 42,
          bullCount: 3,
          bearCount: 1,
          cashCount: 5,
          decisionReasons: [{
            signalSymbol: "TSLA",
            executionSymbol: "TSLL",
            reasons: ["forecast_up", "execution_available"],
          }],
        },
        { id: "kronos" },
        { id: "rust" },
        { id: "ensemble" },
      ],
    });

    const malformed = normalizeAiSimulationSnapshot({
      phase: "running",
      currency: "USD",
      initialCash: 1,
      cash: 1,
      equity: 1,
      progress: 0,
      strategyComparison: {
        conditionId: "condition-2",
        sameOrigin: true,
        sameCosts: true,
        sameExecutionPolicy: true,
        lanes: [lanes.chronos2, lanes.rust],
      },
    });
    expect(malformed.strategyComparison).toBeUndefined();
  });

  it("unwraps start and status responses and keeps errors explicit", () => {
    expect(normalizeAiSimulationRun({
      run: { id: "simulation-1", status: "running" },
      snapshot: {
        phase: "monitoring",
        currency: "KRW",
        initialCash: 1_000_000,
        cash: 1_000_000,
        equity: 1_000_000,
        progress: 0.1,
      },
    })).toMatchObject({
      runId: "simulation-1",
      status: "running",
      snapshot: { phase: "monitoring", currency: "KRW" },
    });
    expect(aiSimulationErrorMessage({ error: { message: "기간이 올바르지 않습니다." } }, "fallback"))
      .toBe("기간이 올바르지 않습니다.");
  });

  it("normalizes durable run history summaries without requiring the live snapshot shape", () => {
    const history = normalizeAiSimulationHistory({
      schemaVersion: "ai-simulation-history-v1",
      items: [{
        run: {
          id: "history-1",
          status: "completed",
          startedAt: "2026-07-24T01:00:00.000Z",
          completedAt: "2026-07-24T01:30:00.000Z",
        },
        configuration: {
          marketCountry: "US",
          preset: "breakout",
          riskTolerance: 92,
          initialCash: 10_000,
          selection: {
            mode: "auto",
            criterion: "volatility",
            symbolCount: 2,
          },
        },
        selected: [{
          symbol: "NVDA",
          name: "NVIDIA",
          model: { modelId: "chronos", device: "cuda" },
        }],
        performance: {
          currency: "USD",
          finalEquity: 10_125,
          returnRatio: 0.0125,
          realizedPnl: 125,
          totalCosts: 2.1,
          tradeCount: 4,
          decisionCount: 18,
        },
        warnings: ["프리마켓 호가를 사용했습니다."],
      }],
      nextCursor: "cursor-2",
    });

    expect(history).toEqual({
      items: [expect.objectContaining({
        runId: "history-1",
        status: "completed",
        marketCountry: "US",
        currency: "USD",
        preset: "breakout",
        riskTolerance: 92,
        selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
        selected: [{ symbol: "NVDA", name: "NVIDIA", model: "chronos · CUDA" }],
        finalEquity: 10_125,
        returnRatio: 0.0125,
        tradeCount: 4,
        decisionCount: 18,
      })],
      nextCursor: "cursor-2",
    });
  });

  it("keeps optional strategy comparisons in history and reports", () => {
    const strategyComparison = {
      conditionId: "condition-history-report",
      pairId: "qqq-tqqq-sqqq",
      sameOrigin: true,
      sameCosts: true,
      sameExecutionPolicy: true,
      incompleteCount: 1,
      lanes: [
        { id: "chronos2", status: "completed", cumulativeReturn: 0.01 },
        { id: "kronos", status: "unavailable", unavailableReason: "model unavailable" },
        { id: "rust", status: "completed", cumulativeReturn: 0.004 },
        { id: "ensemble", status: "completed", cumulativeReturn: 0.008 },
      ],
    };
    const history = normalizeAiSimulationHistory({
      items: [{
        run: { id: "comparison-history", status: "completed" },
        configuration: {
          marketCountry: "US",
          strategy: {
            mode: "pair",
            pairId: "qqq-tqqq-sqqq",
            allowDegradedMode: true,
          },
        },
        performance: { currency: "USD" },
        strategyComparison,
      }],
    });
    expect(history.items[0]).toMatchObject({
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: true,
      },
      strategyComparison: {
        conditionId: "condition-history-report",
        incompleteCount: 1,
        lanes: [
          { id: "chronos2" },
          { id: "kronos", unavailableReason: "model unavailable" },
          { id: "rust" },
          { id: "ensemble" },
        ],
      },
    });

    const report = normalizeAiSimulationReport({
      run: { id: "comparison-report", status: "completed" },
      report: {
        configuration: {
          market_country: "US",
          strategy: {
            mode: "pair",
            pair_id: "qqq-tqqq-sqqq",
            allow_degraded_mode: true,
          },
        },
        performance: { currency: "USD" },
        strategy_comparison: strategyComparison,
      },
    });
    expect(report).toMatchObject({
      configuration: {
        strategy: {
          mode: "pair",
          pairId: "qqq-tqqq-sqqq",
          allowDegradedMode: true,
        },
      },
      strategyComparison: {
        conditionId: "condition-history-report",
        lanes: [{ id: "chronos2" }, { id: "kronos" }, { id: "rust" }, { id: "ensemble" }],
      },
    });
  });

  it("normalizes a run report with configuration, ledger, cadence, model, and chart evidence", () => {
    const report = normalizeAiSimulationReport({
      schemaVersion: "ai-simulation-report-v1",
      run: {
        id: "report-1",
        status: "completed",
        startedAt: "2026-07-24T02:00:00.000Z",
        completedAt: "2026-07-24T02:05:00.000Z",
      },
      report: {
        configuration: {
          marketCountry: "US",
          initialCash: 20_000,
          durationMinutes: 5,
          preset: "trend",
          riskTolerance: 70,
          selection: { mode: "manual", symbols: ["NVDA"] },
          costs: {
            commissionBpsPerSide: 1,
            taxBpsOnExit: 0,
            spreadBpsRoundTrip: 2,
            slippageBpsPerSide: 1,
          },
        },
        selection: {
          selected: [{
            symbol: "NVDA",
            name: "NVIDIA",
            upProbability: 0.67,
            predictedMedianReturn: 0.006,
          }],
        },
        performance: {
          currency: "USD",
          initialCash: 20_000,
          finalEquity: 20_100,
          cash: 20_100,
          realizedPnl: 104,
          totalCosts: 4,
          returnRatio: 0.005,
          tradeCount: 2,
          decisionCount: 3,
        },
        cadence: {
          trigger: "finalized_one_minute_bar",
          triggeredEvents: 3,
          lastFinishedAt: "2026-07-24T02:04:01.000Z",
        },
        decisions: [{
          symbol: "NVDA",
          action: "buy",
          decidedAt: "2026-07-24T02:01:00.000Z",
          reason: "forecast_and_signal_aligned",
          chartPatterns: ["bullish_engulfing"],
          model: { modelId: "chronos", revision: "pinned", device: "cuda" },
        }],
        trades: [{
          symbol: "NVDA",
          side: "buy",
          executedAt: "2026-07-24T02:02:00.000Z",
          price: 170,
          quantity: 2,
          amount: 340,
          cost: 1,
        }],
        positions: [],
        equity: [{
          timestamp: "2026-07-24T02:05:00.000Z",
          equity: 20_100,
          cash: 20_100,
        }],
        charts: [{
          symbol: "NVDA",
          currency: "USD",
          bars: [{
            timestamp: "2026-07-24T02:01:00.000Z",
            open: 169,
            high: 171,
            low: 168,
            close: 170,
            status: "final",
            indicatorValues: {},
          }],
          indicators: [],
          patterns: [],
        }],
        modelProvenance: [{
          modelId: "chronos",
          revision: "pinned",
          device: "cuda",
        }],
        decision_provenance: [{
          decision_id: "decision-1",
          pair_id: "tsla-tsll-tslq",
          signal_symbol: "TSLA",
          execution_symbol: "TSLL",
          direction: "bull",
          origin: "2026-07-24T02:01:00.000Z",
          decision_at: "2026-07-24T02:01:01.000Z",
          degraded: true,
          replay_input: {
            models: {
              chronos2: {
                status: "degraded",
                input_end_at: "2026-07-24T02:01:00.000Z",
                generated_at: "2026-07-24T02:01:00.300Z",
                provenance: {
                  model_id: "amazon/chronos-bolt-small",
                  model_revision: "bolt-revision",
                  device: "cuda:0",
                  device_name: "Tesla P40",
                  latency_ms: 321,
                  fallback_used: true,
                  fallback_from: "amazon/chronos-2",
                  fallback_reason: "cache missing",
                  degraded: true,
                },
              },
              kronos_small: {
                status: "available",
                inputEndAt: "2026-07-24T02:01:00.000Z",
                generatedAt: "2026-07-24T02:01:00.400Z",
                provenance: {
                  modelId: "NeoQuasar/Kronos-small",
                  modelRevision: "kronos-revision",
                  device: "cuda:0",
                  deviceName: "Tesla P40",
                  latencyMs: 456,
                  degraded: false,
                },
              },
            },
          },
        }],
        evidence: [{ label: "chart_pattern", value: "bullish_engulfing" }],
        warnings: ["가상 체결만 생성합니다."],
        limits: ["실주문 없음"],
      },
    });

    expect(report).toMatchObject({
      runId: "report-1",
      status: "completed",
      configuration: {
        marketCountry: "US",
        durationMinutes: 5,
        preset: "trend",
        riskTolerance: 70,
        selection: { mode: "manual", symbols: ["NVDA"] },
      },
      selected: [{ symbol: "NVDA", name: "NVIDIA" }],
      performance: {
        currency: "USD",
        initialCash: 20_000,
        finalEquity: 20_100,
        pnl: 100,
        returnRatio: 0.005,
        tradeCount: 2,
        decisionCount: 3,
      },
      decisionCadence: {
        trigger: "finalized_one_minute_bar",
        triggeredEvents: 3,
      },
      equity: [{ equity: 20_100, cash: 20_100 }],
      charts: [{ symbol: "NVDA" }],
      modelProvenance: ["chronos · pinned · CUDA"],
      decisionProvenance: [{
        decisionId: "decision-1",
        pairId: "tsla-tsll-tslq",
        signalSymbol: "TSLA",
        executionSymbol: "TSLL",
        direction: "bull",
        origin: "2026-07-24T02:01:00.000Z",
        decisionAt: "2026-07-24T02:01:01.000Z",
        degraded: true,
        models: [
          {
            component: "chronos2",
            status: "degraded",
            modelId: "amazon/chronos-bolt-small",
            modelRevision: "bolt-revision",
            origin: "2026-07-24T02:01:00.000Z",
            generatedAt: "2026-07-24T02:01:00.300Z",
            device: "cuda:0",
            deviceName: "Tesla P40",
            latencyMs: 321,
            degraded: true,
            fallbackUsed: true,
            fallbackFrom: "amazon/chronos-2",
            fallbackReason: "cache missing",
          },
          {
            component: "kronos",
            status: "available",
            modelId: "NeoQuasar/Kronos-small",
            modelRevision: "kronos-revision",
            origin: "2026-07-24T02:01:00.000Z",
            generatedAt: "2026-07-24T02:01:00.400Z",
            device: "cuda:0",
            deviceName: "Tesla P40",
            latencyMs: 456,
            degraded: false,
            fallbackUsed: false,
          },
        ],
      }],
      evidence: [{ label: "chart_pattern", value: "bullish_engulfing" }],
      warnings: ["가상 체결만 생성합니다."],
      limits: ["실주문 없음"],
    });
    expect(report?.decisions).toHaveLength(1);
    expect(report?.trades).toHaveLength(1);
  });
});
