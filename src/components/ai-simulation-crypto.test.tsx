import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulationAssetClassControl,
  AiSimulationCryptoSetup,
  toggleCryptoModelLane,
} from "@/components/ai-simulation-crypto";
import {
  AiSimulationFuturesLedger,
  AiSimulationModelComparisonPanel,
} from "@/components/ai-simulation-futures";
import { DEFAULT_AI_SIMULATION_CRYPTO_REQUEST } from "@/lib/ai-simulation";

describe("crypto futures simulation UI", () => {
  it("renders the accessible asset switch and paper-only setup", () => {
    const asset = renderToStaticMarkup(
      <AiSimulationAssetClassControl value="crypto_futures" onChange={() => undefined} />,
    );
    expect(asset).toContain('role="radiogroup"');
    expect(asset).toContain('aria-checked="true"');

    const setup = renderToStaticMarkup(
      <AiSimulationCryptoSetup
        request={DEFAULT_AI_SIMULATION_CRYPTO_REQUEST}
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
    expect(setup).toContain("realOrder capability false");
    expect(setup).toContain("fixture risk bracket unavailable");
    expect(setup).toContain("서버의 paper 실행 gate가 열릴 때까지 시작할 수 없습니다.");
    expect(setup).toContain("자동 선정 · BTCUSDT");
    expect(setup).toContain("암호화폐 선물 scanner 상위 50개 순위 스크롤");
    expect(setup).toContain('data-crypto-candidate="BTCUSDT"');
    expect(setup).toContain('data-crypto-candidate="ALT9USDT"');
    expect(setup).toContain('data-candidate-selected="true"');
    for (const label of [
      "암호화폐 종목 선택 방식",
      "암호화폐 판단 프리셋",
      "암호화폐 공격 방어 성향",
      "암호화폐 scanner 기준",
      "암호화폐 선정 계약 수",
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
    expect(setup).toContain('data-execution-capability="live"');
    expect(
      setup.match(/<button[^>]*data-crypto-simulation-start[^>]*>/)?.[0],
    ).toContain("disabled");
  });

  it("keeps the dual-lane tuple in the backend contract order", () => {
    expect(toggleCryptoModelLane(["kronos_base", "fincast"], "kronos_base"))
      .toEqual(["fincast"]);
    expect(toggleCryptoModelLane(["fincast"], "kronos_base"))
      .toEqual(["kronos_base", "fincast"]);
    expect(toggleCryptoModelLane(["kronos_base"], "kronos_base"))
      .toEqual(["kronos_base"]);
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
          { id: "kronos_base", status: "complete", precision: "fp32", metrics: {} },
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
    expect(comparison).toContain('data-model-lane="kronos_base"');
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
