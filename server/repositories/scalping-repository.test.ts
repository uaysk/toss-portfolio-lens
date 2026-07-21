import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { ScalpingRepository } from "./scalping-repository.js";

describe("ScalpingRepository", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup(): Promise<ScalpingRepository> {
    database = new SqliteDatabase(":memory:");
    const repository = new ScalpingRepository(database);
    await repository.initialize();
    return repository;
  }

  it("진행 중 봉을 저장하고 더 오래된 update로 되돌리지 않으며 확정 봉으로 전이한다", async () => {
    const repository = await setup();
    const base = {
      symbol: "005930",
      intervalMinutes: 1 as const,
      openTime: "2026-07-21T09:00:00+09:00",
      closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21",
      source: "kis_ws" as const,
      open: 100,
      high: 102,
      low: 99,
      volume: 12,
      quality: "complete" as const,
    };
    await repository.putBars([{ ...base, state: "forming", close: 101, updatedAt: 200 }]);
    await repository.putBars([{ ...base, state: "forming", close: 100, updatedAt: 100 }]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1, includeForming: true }))
      .toMatchObject([{ state: "forming", close: 101, updatedAt: 200 }]);

    await repository.putBars([{ ...base, state: "final", close: 102, updatedAt: 300 }]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1 }))
      .toMatchObject([{ state: "final", close: 102, updatedAt: 300 }]);
  });

  it("늦게 도착한 REST 복구가 WebSocket 확정 봉을 덮거나 확정 봉을 진행 중으로 되돌리지 않는다", async () => {
    const repository = await setup();
    const base = {
      symbol: "005930", intervalMinutes: 1 as const,
      openTime: "2026-07-21T09:00:00+09:00", closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21", open: 100, high: 103, low: 99, volume: 12,
      quality: "complete" as const,
    };
    await repository.putBars([{
      ...base, source: "kis_ws", state: "final", close: 102, updatedAt: 100,
    }]);
    await repository.putBars([{
      ...base, source: "kis_rest", state: "final", close: 101, updatedAt: 200,
    }]);
    await repository.putBars([{
      ...base, source: "kis_ws", state: "forming", close: 100, updatedAt: 300,
    }]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1, includeForming: true }))
      .toMatchObject([{ source: "kis_ws", state: "final", close: 102, updatedAt: 100 }]);
  });

  it("잘못된 OHLC와 지원하지 않는 분봉은 저장하지 않는다", async () => {
    const repository = await setup();
    const input = {
      symbol: "005930",
      intervalMinutes: 1 as const,
      openTime: "2026-07-21T09:00:00+09:00",
      closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21",
      source: "kis_ws" as const,
      state: "final" as const,
      open: 100,
      high: 99,
      low: 98,
      close: 100,
      volume: 1,
      quality: "complete" as const,
      updatedAt: 1,
    };
    await expect(repository.putBars([input])).rejects.toThrow("OHLC");
    await expect(repository.putBars([{ ...input, high: 101, intervalMinutes: 2 as never }]))
      .rejects.toThrow("지원하지 않는");
  });

  it("공급자가 주지 않은 거래량을 0으로 만들지 않고 가격 봉은 보존한다", async () => {
    const repository = await setup();
    await repository.putBars([{
      symbol: "005930", intervalMinutes: 1,
      openTime: "2026-07-21T09:00:00+09:00", closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21", source: "toss_rest", state: "final",
      open: 100, high: 101, low: 99, close: 100, quality: "partial", updatedAt: 1,
    }]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1 })).toEqual([
      expect.objectContaining({ close: 100, quality: "partial" }),
    ]);
    expect((await repository.listBars({ symbol: "005930", intervalMinutes: 1 }))[0]).not.toHaveProperty("volume");
  });

  it("새 가격 revision에 거래량이 빠져도 이전에 관측한 거래량을 지우지 않는다", async () => {
    const repository = await setup();
    const base = {
      symbol: "005930", intervalMinutes: 1 as const,
      openTime: "2026-07-21T09:00:00+09:00", closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21", source: "toss_rest" as const, state: "final" as const,
      open: 100, high: 102, low: 99, close: 100, quality: "partial" as const,
    };
    await repository.putBars([{ ...base, volume: 12, updatedAt: 100 }]);
    await repository.putBars([{ ...base, close: 101, updatedAt: 200 }]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1 })).toMatchObject([{
      close: 101, volume: 12, updatedAt: 200,
    }]);
  });

  it("live와 retrospective 예측을 구분하고 모델 provenance를 보존한다", async () => {
    const repository = await setup();
    const input = {
      symbol: "005930",
      modelName: "NeoQuasar/Kronos-small",
      modelVersion: "revision-a",
      inputEndedAt: "2026-07-21T09:30:00+09:00",
      generatedAt: "2026-07-21T09:30:01+09:00",
      status: "available" as const,
      dataQuality: "complete" as const,
      payload: { horizons: [{ minutes: 5, quantiles: { p50: 0.01 } }] },
    };
    await repository.putPrediction({ ...input, retrospective: false, createdAt: 100 });
    await repository.putPrediction({
      ...input,
      generatedAt: "2026-07-21T09:31:01+09:00",
      retrospective: true,
      createdAt: 200,
    });

    expect(await repository.latestPredictions(["005930"])).toMatchObject([{
      retrospective: false,
      modelName: "NeoQuasar/Kronos-small",
      modelVersion: "revision-a",
      status: "available",
    }]);
    expect(await repository.latestPredictions(["005930"], true)).toMatchObject([{
      retrospective: true,
    }]);
  });

  it("입력 종료보다 앞선 생성 시각과 비유한 payload를 거부한다", async () => {
    const repository = await setup();
    const input = {
      symbol: "005930",
      modelName: "model",
      modelVersion: "v1",
      inputEndedAt: "2026-07-21T09:30:00.000Z",
      generatedAt: "2026-07-21T09:29:59.000Z",
      status: "available" as const,
      dataQuality: "complete" as const,
      retrospective: false,
      payload: {},
    };
    await expect(repository.putPrediction(input)).rejects.toThrow("빠를 수 없습니다");
    await expect(repository.putPrediction({
      ...input,
      generatedAt: "2026-07-21T09:30:01.000Z",
      payload: { invalid: Number.NaN },
    })).rejects.toThrow("유한한");
  });
});
