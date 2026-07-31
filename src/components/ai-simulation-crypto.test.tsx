import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulationAssetClassControl,
  AiSimulationCryptoSetup,
} from "@/components/ai-simulation-crypto";
import {
  AiSimulationFuturesLedger,
  AiSimulationModelComparisonPanel,
} from "@/components/ai-simulation-futures";
import { DEFAULT_AI_SIMULATION_CRYPTO_REQUEST } from "@/lib/ai-simulation";

describe("crypto futures simulation UI", () => {
  it("renders the accessible asset switch and paper-only setup", () => {
    const asset = renderToStaticMarkup(
      <AiSimulationAssetClassControl value="btc_eth" onChange={() => undefined} />,
    );
    expect(asset).toContain('role="tablist"');
    expect(asset).toContain('aria-selected="true"');
    expect(asset).toContain('data-simulation-asset-class-option="btc_eth"');
    expect(asset).toContain('data-simulation-asset-class-option="high_vol_crypto"');
    expect(asset).toContain('data-simulation-asset-class-option="us_etf_pair"');

    const setup = renderToStaticMarkup(
      <AiSimulationCryptoSetup
        request={{
          ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
          contractVersion: "ai-paper-simulation/v9",
          simulationCase: "high_vol_crypto",
          scanner: {
            symbolCount: 1,
            minimumListingDays: 90,
            minimumTradingAmountUsd: 25_000_000,
            maximumSpreadBps: 12,
            depthRangeBps: 10,
            minimumDepthUsd: 250_000,
            maximumMissingRate: 0.02,
            rescanIntervalMinutes: 30,
            riskAppetite: "balanced",
          },
        }}
        status={{
          credentialsConfigured: true,
          signedReadSucceeded: true,
          executionGates: { paper: false, testnet: false, live: false },
          workers: {},
        }}
        candidateSnapshot={{
          snapshotId: "snapshot-1",
          criterion: "volatility",
          candidates: Array.from({ length: 9 }, (_, index) => ({
            symbol: index === 0 ? "BTCUSDT" : `ALT${index + 1}USDT`,
            rank: index + 1,
            scoreComponents: {},
            eligible: true,
            filterReasons: [],
            quality: { status: "complete", reasons: [], missing: [], sources: [] },
          })),
          rankings: {},
          warnings: [],
        }}
        candidateLoading={false}
        issues={[]}
        error="fixture risk bracket unavailable"
        disabled={false}
        starting={false}
        active={false}
        cancelling={false}
        cancelRequested={false}
        onRequestChange={() => undefined}
        onRefreshCandidates={() => undefined}
        onStart={() => undefined}
        onCancel={() => undefined}
        limits={{ minimumDurationMinutes: 1, maximumDurationMinutes: 390 }}
      />,
    );
    expect(setup).toContain("Paper 전용 안전 모드");
    expect(setup).toContain("모든 체결은 가상 원장에만 기록됩니다.");
    expect(setup).toContain("data-paper-safety-notice");
    expect(setup).toContain("fixture risk bracket unavailable");
    expect(setup).toContain("서버의 paper 실행 gate가 열릴 때까지 시작할 수 없습니다.");
    expect(setup).toContain("자동 선정 · BTCUSDT");
    expect(setup).toContain("암호화폐 선물 scanner 상위 50개 순위 스크롤");
    expect(setup).toContain('data-crypto-candidate="BTCUSDT"');
    expect(setup).toContain('data-crypto-candidate="ALT9USDT"');
    expect(setup).toContain('data-candidate-selected="true"');
    for (const label of [
      "암호화폐 대상 시장",
      "암호화폐 판단 프리셋",
      "암호화폐 공격 방어 성향",
      "암호화폐 scanner 기준",
      "암호화폐 선정 계약 수",
      "고변동성 최소 거래대금",
      "고변동성 최대 스프레드",
      "고변동성 재스캔 주기",
      "고변동성 scanner 위험 성향",
    ]) {
      expect(setup).toContain(`aria-label="${label}"`);
    }
    expect(setup).toContain("방어 수익");
    expect(setup).toContain("Paper 위험 한도 · 직접 설정");
    expect(setup).toContain("배포에 고정된 안전선 안에서 더 보수적으로만");
    expect(setup).toContain("hard envelope보다 완화할 수 없습니다.");
    expect(setup).toMatch(/aria-label="암호화폐 시작 자산"[^>]*min="100"[^>]*max="100000000"/);
    expect(setup).toMatch(/aria-label="암호화폐 테스트 기간"[^>]*min="1"[^>]*max="390"/);
    for (const [label, value] of [
      ["암호화폐 거래당 위험", "0.5"],
      ["암호화폐 UTC 일손실 중단선", "3"],
      ["암호화폐 최대 레버리지", "15"],
      ["암호화폐 Gross exposure 상한", "150"],
      ["암호화폐 증거금 사용률 상한", "20"],
      ["암호화폐 청산 buffer / 손절", "2"],
    ]) {
      expect(setup).toMatch(new RegExp(`aria-label="${label}"[^>]*value="${value}"`));
    }
    expect(setup).toMatch(
      /aria-label="암호화폐 증거금 사용률 상한"[^>]*max="100"/,
    );
    expect(setup).toContain('data-execution-capability="paper"');
    expect(setup).not.toContain('data-execution-capability="live"');
    expect(
      setup.match(/<button[^>]*data-crypto-simulation-start[^>]*>/)?.[0],
    ).toContain("disabled");
  });

  it("renders long cyan/short amber ledger semantics and independent lanes", () => {
    const ledger = renderToStaticMarkup(
      <AiSimulationFuturesLedger
        positions={[{
          symbol: "BTCUSDT",
          side: "long",
          marginMode: "isolated",
          quantity: 0.01,
          leverage: 5,
          entryPrice: 67_100,
        }]}
        risk={{
          newEntriesBlocked: false,
          riskPerTradeRatio: 0.008,
          dailyLossLimitRatio: 0.05,
          grossExposureRatio: 0.4,
          grossExposureLimitRatio: 1.2,
          marginUsageRatio: 0.1,
          marginUsageLimitRatio: 0.3,
          maximumLeverage: 12,
          liquidationBufferMultiple: 2.5,
        }}
      />,
    );
    expect(ledger).toContain('data-futures-position-side="long"');
    expect(ledger).toContain("reduce-only");
    expect(ledger).toContain("거래당 위험");
    expect(ledger).toContain("0.80%");
    expect(ledger).toContain("Gross exposure / 한도");
    expect(ledger).toContain("40.00% / 120.00%");
    expect(ledger).toContain("12×");
    expect(ledger).toContain("2.50×");

    const comparison = renderToStaticMarkup(
      <AiSimulationModelComparisonPanel comparison={{
        outcome: "inconclusive",
        sameOrigin: true,
        sameContext: true,
        sameCosts: true,
        sameFillBarrier: true,
        lanes: [
          { id: "chronos2", status: "complete", precision: "fp32", metrics: {} },
          {
            id: "fincast",
            status: "complete",
            precision: "fp16",
            metrics: {
              calibrationError: 0.03,
              funding: -1.25,
              fees: 2.5,
              timeoutCount: 2,
              leverageDistribution: [3, 5, 5],
            },
            provenance: {
              modelId: "Vincent05R/FinCast",
              modelRevision: "fincast-revision",
              sourceRevision: "source-revision",
              loaderVersion: "loader-v1",
              loaded: true,
              device: "cuda:0",
              deviceName: "Tesla P40",
              precisionValidation: "passed",
              memoryStatus: "ok",
              peakVramMb: 4_920,
              precisionFailureReasons: [],
            },
          },
        ],
      }} />,
    );
    expect(comparison).toContain('data-model-lane="chronos2"');
    expect(comparison).toContain('data-model-lane="fincast"');
    expect(comparison).toContain('data-model-lane-provenance="fincast"');
    expect(comparison).toContain("Vincent05R/FinCast");
    expect(comparison).toContain("fincast-revision");
    expect(comparison).toContain("Tesla P40");
    expect(comparison).toContain("precision validation passed");
    expect(comparison).toContain("Calibration error");
    expect(comparison).toContain("3× 1회 · 5× 2회");
    expect(comparison).toContain("2회");
    expect(comparison).toContain("/reports/crypto-scalping-model-comparison.html");
  });
});
