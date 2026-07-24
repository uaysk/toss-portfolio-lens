import { describe, expect, it } from "vitest";
import type { MarketCountry, NormalizedRanking } from "./contracts.js";
import { CandidateUniverseService } from "./candidate-universe-service.js";

function ranking(
  symbol: string,
  rank: number,
  marketCountry: MarketCountry = "KR",
): NormalizedRanking {
  return {
    provider: "toss",
    symbol,
    marketCountry,
    currency: marketCountry === "KR" ? "KRW" : "USD",
    rank,
    rankedAt: "2026-07-24T00:00:00.000Z",
    price: 100,
  };
}

describe("CandidateUniverseService", () => {
  it("요청 종목을 우선하고 현재 시장의 랭킹만 안정적으로 정렬한다", () => {
    const subject = new CandidateUniverseService({ maximumCandidates: 10 });

    expect(subject.select({
      marketCountry: "KR",
      rankings: [
        ranking("US-ONLY", 1, "US"),
        ranking("KR-C", 2),
        ranking("KR-B", 1),
        ranking("KR-A", 1),
        ranking("KR-B", 4),
      ],
      requestedSymbols: ["MANUAL", "KR-C"],
      desiredCount: 2,
      criterion: "volume",
    })).toEqual(["MANUAL", "KR-C", "KR-A", "KR-B"]);
  });

  it("요청 종목이 많아도 설정 상한을 넘지 않는다", () => {
    const subject = new CandidateUniverseService({ maximumCandidates: 3 });

    expect(subject.select({
      marketCountry: "US",
      rankings: [ranking("RANKED", 1, "US")],
      requestedSymbols: ["FIRST", "SECOND", "THIRD", "FOURTH"],
      desiredCount: 1,
      criterion: "trading_amount",
    })).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("변동성 스캔과 일반 스캔의 후보 headroom을 기존 정책대로 제한한다", () => {
    const subject = new CandidateUniverseService({ maximumCandidates: 30 });
    const rankings = Array.from({ length: 30 }, (_, index) => ranking(`KR-${String(index).padStart(2, "0")}`, index + 1));
    const base = {
      marketCountry: "KR" as const,
      rankings,
      requestedSymbols: [],
      desiredCount: 3,
    };

    expect(subject.select({ ...base, criterion: "volume" })).toHaveLength(10);
    expect(subject.select({ ...base, criterion: "volatility" })).toHaveLength(20);
  });

  it("같은 순위에서는 symbol 순서로 결정론적으로 정렬한다", () => {
    const subject = new CandidateUniverseService({ maximumCandidates: 10 });

    expect(subject.select({
      marketCountry: "KR",
      rankings: [ranking("CCC", 1), ranking("AAA", 1), ranking("BBB", 1)],
      requestedSymbols: [],
      desiredCount: 1,
      criterion: "volume",
    })).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("유효하지 않은 상한 구성을 거부한다", () => {
    expect(() => new CandidateUniverseService({ maximumCandidates: 0 })).toThrow(
      /maximumCandidates must be a positive integer/,
    );
  });
});
