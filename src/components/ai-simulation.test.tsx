import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulation,
  AiSimulationStrategySettings,
  SimulationDisclosure,
  TradesAndDecisions,
  UnifiedPolicyEvidencePanel,
  aiSimulationRequestWithStrategy,
  aiSimulationChartLayout,
  cryptoRequestForCase,
  etfRequest,
  simulationDecisionCadenceLabel,
} from "./ai-simulation";
import { AiSimulationComparisonPanel } from "./ai-simulation-comparison-panel";
import {
  AI_SIMULATION_PAIR_CATALOG,
  DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  DEFAULT_AI_SIMULATION_REQUEST,
  type AiSimulationSnapshot,
  type AiSimulationStrategyComparison,
} from "@/lib/ai-simulation";

describe("AI simulation disclosure", () => {
  it("states the virtual-only and next-valid-fill boundary verbatim", () => {
    const markup = renderToStaticMarkup(<SimulationDisclosure />);
    expect(markup).toContain("실주문 없음, 투자 지시 아님, 다음 유효 체결만.");
    expect(markup).toContain("가상 원장에만 반영");
  });
});

describe("AiSimulation", () => {
  it("describes finalized-bar event cadence without inventing a fixed interval", () => {
    expect(simulationDecisionCadenceLabel(undefined)).toBe("확정봉 이벤트 즉시");
    expect(simulationDecisionCadenceLabel("finalized_one_minute_bar")).toBe("새 확정 1분봉 즉시");
    expect(simulationDecisionCadenceLabel("final_fincast_30s_aggtrade_bar"))
      .toBe("FinCast 새 확정 30초봉 즉시");
    expect(simulationDecisionCadenceLabel("final_fincast_15s_aggtrade_bar"))
      .toBe("FinCast 새 확정 15초봉 즉시");
    expect(simulationDecisionCadenceLabel("high_vol_live_5s"))
      .toBe("고변동성 실시간 5초");
  });

  it.each([
    ["qqq-tqqq-sqqq", "QQQ", ["TQQQ", "SQQQ"]],
    ["smh-soxl-soxs", "SMH", ["SOXL", "SOXS"]],
  ] as const)("places the %s signal chart first and full-width", (pairId, primary, leveraged) => {
    const symbols = [leveraged[0], primary, leveraged[1]];
    const layout = aiSimulationChartLayout({
      market: { kind: "stock", country: "US" },
      strategy: { mode: "pair", pairId, allowDegradedMode: false },
      decisions: [],
      charts: symbols.map((symbol) => ({
        symbol,
        currency: "USD",
        bars: [],
        indicators: [],
        patterns: [],
      })),
    }, [{ signalSymbol: primary }]);

    expect(layout.layout).toBe("pair-primary-full-width");
    expect(layout.primarySymbol).toBe(primary);
    expect(layout.charts.map((chart) => chart.symbol)).toEqual([primary, ...leveraged]);
  });

  it("uses the v4 catalog model target instead of forecast sort order for pair charts", () => {
    const layout = aiSimulationChartLayout({
      market: { kind: "stock", country: "US" },
      strategy: { mode: "pair", pairId: "spy-spxl-spxs", allowDegradedMode: false },
      decisions: [],
      charts: ["SPY", "SPXL", "SPXS"].map((symbol) => ({
        symbol,
        currency: "USD",
        bars: [],
        indicators: [],
        patterns: [],
      })),
    }, [{ signalSymbol: "SPXL" }, { signalSymbol: "SPY" }]);

    expect(layout.primarySymbol).toBe("SPY");
    expect(layout.charts.map((chart) => chart.symbol)).toEqual(["SPY", "SPXL", "SPXS"]);
  });

  it("keeps crypto charts in a full-width vertical layout", () => {
    const layout = aiSimulationChartLayout({
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      decisions: [],
      charts: [{
        symbol: "BTCUSDT",
        currency: "USDT",
        bars: [],
        indicators: [],
        patterns: [],
      }],
    }, []);

    expect(layout.layout).toBe("crypto-full-width");
    expect(layout.charts).toHaveLength(1);
  });

  it("renders the three strategy cases and the BTC·ETH paper setup", () => {
    const markup = renderToStaticMarkup(<AiSimulation onUnauthorized={() => undefined} />);
    expect(markup).toContain('data-ai-simulation="true"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('data-simulation-asset-class-option="btc_eth"');
    expect(markup).toContain('data-simulation-asset-class-option="high_vol_crypto"');
    expect(markup).toContain('data-simulation-asset-class-option="us_etf_pair"');
    expect(markup).toContain("BTC·ETH");
    expect(markup).toContain("고변동성 암호화폐");
    expect(markup).toContain("미국 ETF 페어");
    expect(markup).toContain('aria-label="암호화폐 시작 자산"');
    expect(markup).toContain('aria-label="암호화폐 테스트 기간"');
    expect(markup).toContain("BTC C2→FinCast veto");
    expect(markup).toContain("ETH FinCast→C2 shadow");
    expect(markup).toContain("확정봉 이벤트 즉시");
    expect(markup).toContain("AI 시뮬레이션 시작");
    expect(markup).toContain('data-simulation-empty="true"');
    expect(markup).toContain("시뮬레이션 기록·결과 보고서");
    expect(markup).toContain('data-simulation-history-disclosure="true"');
    expect(markup).toContain('data-simulation-history-toggle="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("기록 펼치기");
    expect(markup).not.toContain('data-simulation-history="true"');
  });

  it("builds strict v9 payloads and leaves model-plan resolution to the server", () => {
    const btcRequest = cryptoRequestForCase("btc_eth", DEFAULT_AI_SIMULATION_CRYPTO_REQUEST);
    expect(btcRequest).toMatchObject({
        contractVersion: "ai-paper-simulation/v9",
        simulationCase: "btc_eth",
        selection: { mode: "manual", symbols: ["BTCUSDT", "ETHUSDT"] },
      });
    expect(btcRequest).not.toHaveProperty("modelLanes");
    expect(btcRequest).not.toHaveProperty("modelPlan");
    expect(cryptoRequestForCase("high_vol_crypto", DEFAULT_AI_SIMULATION_CRYPTO_REQUEST))
      .toMatchObject({
        contractVersion: "ai-paper-simulation/v9",
        simulationCase: "high_vol_crypto",
        selection: { mode: "auto", symbolCount: 1 },
        scanner: {
          minimumTradingAmountUsd: 25_000_000,
          maximumSpreadBps: 12,
          rescanIntervalMinutes: 30,
        },
      });
    const pairRequest = etfRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      strategy: { mode: "pair", pairId: "spy-spxl-spxs", allowDegradedMode: false },
    });
    expect(pairRequest).toMatchObject({
      contractVersion: "ai-paper-simulation/v9",
      simulationCase: "us_etf_pair",
      market: { kind: "stock", country: "US" },
      strategy: { mode: "pair", pairId: "spy-spxl-spxs", allowDegradedMode: false },
    });
    expect(pairRequest).not.toHaveProperty("marketCountry");
    expect(pairRequest).not.toHaveProperty("modelLanes");
    expect(pairRequest).not.toHaveProperty("modelPlan");
  });

  it("renders fail-closed evidence, tails, policy gates, costs, mapping, and scanner facts", () => {
    const snapshot: AiSimulationSnapshot = {
      phase: "running",
      simulationCase: "high_vol_crypto",
      resolvedModelPlan: [{
        symbol: "*",
        modelLane: "chronos2",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30],
      }],
      currency: "USDT",
      initialCash: 10_000,
      cash: 10_000,
      equity: 10_000,
      progress: 0.5,
      selected: [],
      positions: [],
      charts: [],
      trades: [],
      decisions: [],
      modelForecasts: [],
      warnings: [],
      capabilities: {},
      modelEvidence: [{
        symbol: "SOLUSDT",
        modelLane: "chronos2",
        role: "primary",
        modelId: "amazon/chronos-2",
        modelRevision: "pinned",
        horizonMinutes: 30,
        q01Return: -0.04,
        q05Return: -0.025,
        q10Return: -0.02,
        q50Return: 0.004,
        q90Return: 0.03,
        q95Return: 0.04,
        q99Return: 0.07,
        expectedReturn: 0.004,
        expectedNetReturn: 0.002,
        pNetLong: 0.63,
        pNetShort: 0.22,
        intervalWidth: 0.05,
        expectedShortfall: 0.028,
        calibrationStatus: "ready",
        calibrationAge: 12,
        featureProfile: "compact_causal_v1",
        latencyMs: 150,
        inputOrigin: "historical",
        dataQuality: {
          status: "degraded",
          missingRate: 0.01,
          unavailableFeatures: ["open_interest"],
          warnings: ["liquidation_unavailable"],
        },
      }],
      unifiedPolicyDecisions: [{
        direction: "cash",
        executionAction: "none",
        selectedHorizonMinutes: 30,
        expectedGrossReturn: 0.004,
        expectedNetReturn: 0.002,
        pNetLong: 0.63,
        pNetShort: 0.22,
        rustRegime: "trending",
        passedIndicatorGates: ["ADX"],
        blockedIndicatorGates: ["SPREAD"],
        veto: { vetoed: true, reasons: ["TAIL_LOSS_LIMIT"] },
        circuitBreaker: {
          active: true,
          triggers: ["DATA_STALE"],
          releaseConditions: ["CLEAR_DATA_STALE"],
        },
        costBreakdown: {
          commissionBps: 4,
          spreadBps: 3,
          slippageBps: 2,
          fundingBps: 1,
          safetyMarginBps: 2,
          totalLongBps: 12,
          totalShortBps: 10,
        },
      }],
      highVolatilityScanner: {
        scannedAt: "2026-07-28T00:00:00.000Z",
        totalCandidateCount: 2,
        eligibleCandidateCount: 1,
        selectedSymbols: ["SOLUSDT"],
        dataFreshnessMs: 1_000,
        candidates: [{
          symbol: "SOLUSDT",
          score: 0.82,
          freshnessMs: 1_000,
          exclusionReasons: [],
          metrics: {
            realizedVolatility: 0.04,
            normalizedAtr: 0.03,
            relativeVolume: 1.8,
            tradingAmountUsd: 40_000_000,
            medianSpreadBps: 2,
            depthUsd: 600_000,
          },
        }],
      },
    };
    const markup = renderToStaticMarkup(<UnifiedPolicyEvidencePanel snapshot={snapshot} />);
    expect(markup).toContain("q01");
    expect(markup).toContain("q99");
    expect(markup).toContain("open_interest");
    expect(markup).toContain("TAIL_LOSS_LIMIT");
    expect(markup).toContain("DATA_STALE");
    expect(markup).toContain("CLEAR_DATA_STALE");
    expect(markup).toContain("commission 4bps");
    expect(markup).toContain("RVOL 1.800");
  });

  it("keeps the complete decision history inside a bounded scroll region", () => {
    const decisions = Array.from({ length: 25 }, (_, index) => ({
      symbol: "005930",
      action: "watch",
      decidedAt: new Date(Date.UTC(2026, 6, 24, 0, index)).toISOString(),
      reason: `decision-${index + 1}`,
      chartPatterns: [],
    }));
    const snapshot: AiSimulationSnapshot = {
      phase: "running",
      currency: "KRW",
      initialCash: 10_000_000,
      cash: 10_000_000,
      equity: 10_000_000,
      progress: 0.5,
      selected: [],
      positions: [],
      charts: [],
      trades: [],
      decisions,
      modelForecasts: [],
      warnings: [],
      capabilities: {},
    };
    const markup = renderToStaticMarkup(<TradesAndDecisions snapshot={snapshot} />);
    expect(markup).toContain('data-simulation-decisions-scroll="true"');
    expect(markup).toContain("max-h-[28rem]");
    expect(markup).toContain("decision-1");
    expect(markup).toContain("decision-25");
  });

  it("labels crypto futures fills in contracts instead of shares", () => {
    const snapshot: AiSimulationSnapshot = {
      phase: "running",
      currency: "USDT",
      initialCash: 10_000,
      cash: 9_900,
      equity: 10_010,
      progress: 0.5,
      selected: [],
      positions: [],
      charts: [],
      trades: [{
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.01,
        price: 67_100,
        amount: 671,
        cost: 0.27,
        executedAt: "2026-07-25T00:01:00.000Z",
      }],
      decisions: [],
      modelForecasts: [],
      warnings: [],
      capabilities: {},
    };

    const markup = renderToStaticMarkup(<TradesAndDecisions snapshot={snapshot} />);
    expect(markup).toContain("0.01계약");
    expect(markup).not.toContain("0.01주");
  });

  it("renders the US pair catalog with a fixed fail-closed policy", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationStrategySettings
        request={{
          ...DEFAULT_AI_SIMULATION_REQUEST,
          market: { kind: "stock", country: "US" },
          strategy: {
            mode: "pair",
            pairId: "tsla-tsll-tslq",
            allowDegradedMode: false,
          },
        }}
        catalog={AI_SIMULATION_PAIR_CATALOG}
        pairEnabled
        disabled={false}
        onModeChange={() => undefined}
        onPairIdChange={() => undefined}
      />,
    );
    expect(markup).toContain('data-simulation-pair-settings="true"');
    expect(markup).toContain('aria-label="미국 페어 카탈로그"');
    expect(markup).toContain("Chronos-2가 기초 ETF를 예측");
    expect(markup).toContain("Rust 세션·유동성 gate");
    expect(markup).toContain("Model target과 execution leg는 분리");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("degraded 실행 허용");
  });

  it("switches pair requests to US defaults without retaining manual symbols", () => {
    expect(aiSimulationRequestWithStrategy({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      selection: { mode: "manual", symbols: ["005930"] },
    }, {
      mode: "pair",
      pairId: "qqq-tqqq-sqqq",
    })).toMatchObject({
      market: { kind: "stock", country: "US" },
      initialCash: 100_000,
      selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: false,
      },
      costs: { commissionBpsPerSide: 10, taxBpsOnExit: 0 },
    });
  });

  it("renders mobile one-column and desktop three-column Chronos-2/Rust/final comparisons", () => {
    const comparison: AiSimulationStrategyComparison = {
      conditionId: "ui-condition-1",
      pairId: "tsla-tsll-tslq",
      sameOrigin: true,
      sameCosts: true,
      sameExecutionPolicy: true,
      incompleteCount: 0,
      lanes: [
        {
          id: "chronos2",
          status: "completed",
          analyticalOnly: true,
          cumulativeReturn: 0.012,
          netReturn: 0.01,
          maxDrawdown: 0.004,
          bullCount: 3,
          bearCount: 1,
          cashCount: 5,
          decisionReasons: [{
            reason: "forecast_up",
            reasons: ["forecast_up", "technical_confirmed"],
            signalSymbol: "TSLA",
            executionSymbol: "TSLL",
            action: "bull",
          }],
        },
        { id: "rust", status: "completed", analyticalOnly: true, cumulativeReturn: 0.004, decisionReasons: [] },
        { id: "ensemble", status: "completed", analyticalOnly: true, cumulativeReturn: 0.011, decisionReasons: [] },
      ],
    };
    const markup = renderToStaticMarkup(
      <AiSimulationComparisonPanel comparison={comparison} currency="USD" />,
    );
    expect(markup).toContain('data-simulation-strategy-comparison="ui-condition-1"');
    expect(markup).toContain("grid-cols-1");
    expect(markup).toContain("sm:grid-cols-3");
    expect(markup).toContain('data-simulation-comparison-lane="chronos2"');
    expect(markup).toContain('data-simulation-comparison-lane="ensemble"');
    expect(markup).toContain("Chronos-2");
    expect(markup).toContain("Rust 기술 지표");
    expect(markup).toContain("최종 전략");
    expect(markup).toContain("forward 실행 정책");
    expect(markup.match(/비교 성과 분석용/g)).toHaveLength(3);
    expect(markup).toContain("모든 lane의 비교 성과는 분석·검증용");
    expect(markup).toContain("bull 3 · bear 1 · cash 5");
    expect(markup.match(/data-simulation-comparison-analytical-only="true"/g)).toHaveLength(3);
    expect(markup).toContain("technical_confirmed");
    expect(markup).not.toContain("Kronos-base");
    expect(markup).not.toContain("NeoQuasar");
  });
});
