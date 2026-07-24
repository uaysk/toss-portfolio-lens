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
          candidates: [{
            symbol: "BTCUSDT",
            scoreComponents: {},
            eligible: true,
            filterReasons: [],
            quality: { status: "complete", reasons: [], missing: [], sources: [] },
          }],
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
      />,
    );
    expect(setup).toContain("realOrder capability false");
    expect(setup).toContain("fixture risk bracket unavailable");
    expect(setup).toContain("서버의 paper 실행 gate가 열릴 때까지 시작할 수 없습니다.");
    expect(setup).toContain("자동 선택 후보 · BTCUSDT");
    expect(setup).toContain("암호화폐 선물 scanner 순위 가로 스크롤");
    expect(setup).toContain('data-crypto-candidate="BTCUSDT"');
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
        risk={{ newEntriesBlocked: false, riskPerTradeRatio: 0.005 }}
      />,
    );
    expect(ledger).toContain('data-futures-position-side="long"');
    expect(ledger).toContain("reduce-only");

    const comparison = renderToStaticMarkup(
      <AiSimulationModelComparisonPanel comparison={{
        outcome: "inconclusive",
        sameOrigin: true,
        sameContext: true,
        sameCosts: true,
        sameFillBarrier: true,
        lanes: [
          { id: "kronos_base", status: "complete", precision: "fp32", metrics: {} },
          { id: "fincast", status: "complete", precision: "fp16", metrics: {} },
        ],
      }} />,
    );
    expect(comparison).toContain('data-model-lane="kronos_base"');
    expect(comparison).toContain('data-model-lane="fincast"');
    expect(comparison).toContain("/reports/crypto-scalping-model-comparison.html");
  });
});
