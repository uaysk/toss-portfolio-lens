import { afterEach, describe, expect, it, vi } from "vitest";
import { type RelationalDatabase, SqliteDatabase } from "../database.js";
import {
  ScalpingRepository,
  type ScalpingOrderbookRecord,
  type ScalpingRecordingEventRecord,
  type ScalpingTradeRecord,
} from "./scalping-repository.js";

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

  function trade(overrides: Partial<ScalpingTradeRecord> = {}): ScalpingTradeRecord {
    return {
      marketCountry: "US",
      symbol: "TSLA",
      eventId: "kis:HDFSCNT0:standard:NAS:TSLA:20260724:093000:1:220:1",
      provider: "kis",
      venue: "US",
      exchange: "NAS",
      sessionFeed: "standard",
      sessionDate: "2026-07-24",
      executedAt: "2026-07-24T09:30:00-04:00",
      receivedAt: "2026-07-24T13:30:00.100Z",
      price: 220,
      quantity: 1,
      tradingAmount: 220,
      side: "unknown",
      cumulativeVolume: 1,
      cumulativeAmount: 220,
      executionStrength: 101.5,
      executionClass: "0",
      bestBidPrice: 219.99,
      bestAskPrice: 220.01,
      recordedAt: 1,
      ...overrides,
    };
  }

  function orderbook(overrides: Partial<ScalpingOrderbookRecord> = {}): ScalpingOrderbookRecord {
    return {
      snapshotId: "00000000-0000-4000-8000-000000000001",
      marketCountry: "US",
      symbol: "TSLA",
      provider: "kis",
      venue: "US",
      exchange: "NAS",
      sessionFeed: "standard",
      sessionDate: "2026-07-24",
      observedAt: "2026-07-24T09:30:00-04:00",
      receivedAt: "2026-07-24T13:30:00.100Z",
      depth: "top_of_book",
      asks: [{ price: 220.01, quantity: 2 }],
      bids: [{ price: 219.99, quantity: 3 }],
      totalAskQuantity: 2,
      totalBidQuantity: 3,
      bestAskPrice: 220.01,
      bestAskQuantity: 2,
      bestBidPrice: 219.99,
      bestBidQuantity: 3,
      recordedAt: 1,
      ...overrides,
    };
  }

  function recordingEvent(
    overrides: Partial<ScalpingRecordingEventRecord> = {},
  ): ScalpingRecordingEventRecord {
    return {
      eventId: "00000000-0000-4000-8000-000000000010",
      marketCountry: "US",
      symbol: "TSLA",
      eventType: "data_gap",
      occurredAt: "2026-07-24T13:30:00.000Z",
      code: "trade-feed-silence",
      details: { feed: "standard", gapMs: 15_000 },
      recordedAt: 10,
      ...overrides,
    };
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

  it("연결 중간부터 수집한 partial WebSocket 봉보다 완전한 REST 복구 봉을 우선한다", async () => {
    const repository = await setup();
    const base = {
      symbol: "AAPL", marketCountry: "US" as const, intervalMinutes: 1 as const,
      openTime: "2026-07-21T13:30:00.000Z", closeTime: "2026-07-21T13:31:00.000Z",
      sessionDate: "2026-07-21", state: "final" as const,
    };
    await repository.putBars([{
      ...base,
      source: "kis_ws",
      open: 101,
      high: 102,
      low: 101,
      close: 102,
      volume: 4,
      quality: "partial",
      updatedAt: 200,
    }]);
    await repository.putBars([{
      ...base,
      source: "kis_rest",
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: 20,
      quality: "recovered",
      updatedAt: 100,
    }]);
    expect(await repository.listBars({ marketCountry: "US", symbol: "AAPL", intervalMinutes: 1 }))
      .toMatchObject([{
        source: "kis_rest", quality: "recovered", open: 100, high: 103, low: 99, volume: 20,
      }]);
  });

  it("종료 단일가까지 완성한 recovered 봉은 먼저 확정된 불완전 WS 봉을 교체한다", async () => {
    const repository = await setup();
    const base = {
      symbol: "005930", marketCountry: "KR" as const, intervalMinutes: 1 as const,
      openTime: "2026-07-21T06:29:00.000Z", closeTime: "2026-07-21T06:30:00.000Z",
      sessionDate: "2026-07-21", state: "final" as const,
    };
    await repository.putBars([{
      ...base,
      source: "kis_ws",
      open: 100, high: 101, low: 99, close: 100, volume: 10,
      quality: "complete",
      updatedAt: 100,
    }]);
    await repository.putBars([{
      ...base,
      source: "recovered",
      open: 100, high: 105, low: 98, close: 104, volume: 1_829_148,
      quality: "recovered",
      updatedAt: 200,
    }]);
    expect(await repository.listBars({ marketCountry: "KR", symbol: "005930", intervalMinutes: 1 }))
      .toMatchObject([{
        source: "recovered", quality: "recovered", high: 105, low: 98, close: 104, volume: 1_829_148,
      }]);
  });

  it("NXT RVOL 이력에 필요한 4,200개 분봉 조회를 저장소에서 자르지 않는다", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const relational = {
      dialect: "sqlite" as const,
      run: vi.fn(),
      query,
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const repository = new ScalpingRepository(relational);
    await repository.listBars({
      marketCountry: "KR",
      symbol: "005930",
      intervalMinutes: 1,
      includeForming: true,
      limit: 4_200,
    });
    expect(query.mock.calls[0]?.[0]).toContain("LIMIT 4200");
  });

  it("4,200개 NXT RVOL 분봉을 행별 쿼리 대신 제한된 batch upsert로 저장한다", async () => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 500, insertId: 0 });
    const transactionDatabase = {
      dialect: "sqlite" as const,
      run,
      query: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const transaction = vi.fn(async (work: (database: RelationalDatabase) => Promise<unknown>) => (
      work(transactionDatabase)
    ));
    const relational = {
      dialect: "sqlite" as const,
      run: vi.fn(),
      query: vi.fn(),
      transaction,
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const base = Date.parse("2026-07-14T23:00:00.000Z");
    const bars = Array.from({ length: 4_200 }, (_, index) => ({
      marketCountry: "KR" as const,
      symbol: "005930",
      intervalMinutes: 1 as const,
      openTime: new Date(base + index * 60_000).toISOString(),
      closeTime: new Date(base + (index + 1) * 60_000).toISOString(),
      sessionDate: new Date(base + index * 60_000 + 9 * 60 * 60_000).toISOString().slice(0, 10),
      source: "toss_rest" as const,
      state: "final" as const,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      quality: "complete" as const,
      updatedAt: 1,
    }));

    await new ScalpingRepository(relational).putBars(bars);

    expect(transaction).toHaveBeenCalledOnce();
    expect(relational.run).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(9);
    expect(run.mock.calls.every(([, parameters]) => (parameters as unknown[]).length <= 9_000)).toBe(true);
    expect(run.mock.calls.reduce((total, [, parameters]) => total + (parameters as unknown[]).length, 0))
      .toBe(4_200 * 18);
  });

  it("한 batch의 같은 분봉 revision도 입력 순서와 확정 우선순위를 유지한다", async () => {
    const repository = await setup();
    const base = {
      symbol: "005930", intervalMinutes: 1 as const,
      openTime: "2026-07-21T09:00:00+09:00", closeTime: "2026-07-21T09:01:00+09:00",
      sessionDate: "2026-07-21", source: "kis_ws" as const,
      open: 100, high: 102, low: 99, volume: 12, quality: "complete" as const,
    };
    await repository.putBars([
      { ...base, state: "forming", close: 101, updatedAt: 200 },
      { ...base, state: "forming", close: 100, updatedAt: 100 },
      { ...base, state: "final", close: 102, updatedAt: 300 },
    ]);
    expect(await repository.listBars({ symbol: "005930", intervalMinutes: 1, includeForming: true }))
      .toMatchObject([{ state: "final", close: 102, updatedAt: 300 }]);
  });

  it("MySQL upsert는 우선순위 predicate 의존 필드를 안전한 순서로 마지막에 갱신한다", async () => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 1, insertId: 0 });
    const mysql = {
      dialect: "mysql" as const,
      run,
      query: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    await new ScalpingRepository(mysql).putBars([{
      marketCountry: "US",
      symbol: "AAPL",
      intervalMinutes: 1,
      openTime: "2026-07-21T13:30:00.000Z",
      closeTime: "2026-07-21T13:31:00.000Z",
      sessionDate: "2026-07-21",
      source: "kis_rest",
      state: "final",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      quality: "recovered",
      updatedAt: 1,
    }]);
    const sql = String(run.mock.calls[0]?.[0]);
    const updateAt = sql.lastIndexOf("updated_at = IF");
    const sourceKind = sql.lastIndexOf("source_kind = IF");
    const qualityStatus = sql.lastIndexOf("quality_status = IF");
    const barState = sql.lastIndexOf("bar_state = IF");
    expect(updateAt).toBeGreaterThan(0);
    expect(updateAt).toBeLessThan(sourceKind);
    expect(sourceKind).toBeLessThan(qualityStatus);
    expect(qualityStatus).toBeLessThan(barState);
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

  it("같은 종목·시각의 국내와 미국 분봉 및 예측을 marketCountry로 완전히 격리한다", async () => {
    const repository = await setup();
    const baseBar = {
      symbol: "AAPL",
      intervalMinutes: 1 as const,
      openTime: "2026-07-21T13:30:00.000Z",
      closeTime: "2026-07-21T13:31:00.000Z",
      sessionDate: "2026-07-21",
      source: "kis_rest" as const,
      state: "final" as const,
      open: 100,
      high: 202,
      low: 99,
      volume: 10,
      quality: "complete" as const,
      updatedAt: 1,
    };
    await repository.putBars([
      { ...baseBar, marketCountry: "KR", close: 101 },
      { ...baseBar, marketCountry: "US", close: 201 },
    ]);

    expect(await repository.listBars({ symbol: "AAPL", intervalMinutes: 1 })).toMatchObject([
      { marketCountry: "KR", close: 101 },
    ]);
    expect(await repository.listBars({ marketCountry: "US", symbol: "AAPL", intervalMinutes: 1 })).toMatchObject([
      { marketCountry: "US", close: 201 },
    ]);

    const basePrediction = {
      symbol: "AAPL",
      modelName: "model",
      modelVersion: "v1",
      inputEndedAt: "2026-07-21T13:30:00.000Z",
      generatedAt: "2026-07-21T13:30:01.000Z",
      status: "available" as const,
      dataQuality: "complete" as const,
      retrospective: false,
    };
    await repository.putPrediction({
      ...basePrediction, id: "kr-prediction", marketCountry: "KR", payload: { p50: 0.01 },
    });
    await repository.putPrediction({
      ...basePrediction, id: "us-prediction", marketCountry: "US", payload: { p50: 0.02 },
    });

    expect(await repository.latestPredictions(["AAPL"])).toMatchObject([
      { id: "kr-prediction", marketCountry: "KR", payload: { p50: 0.01 } },
    ]);
    expect(await repository.latestPredictions(["AAPL"], false, "US")).toMatchObject([
      { id: "us-prediction", marketCountry: "US", payload: { p50: 0.02 } },
    ]);
  });

  it("미국 체결 원본을 시간순으로 보존하고 재전송 eventId를 중복 저장하지 않는다", async () => {
    const repository = await setup();
    const first = trade();
    const sameProviderSecond = trade({
      eventId: "kis:HDFSCNT0:day:NAS:TSLA:20260724:093000:2:220.1:1",
      sessionFeed: "day",
      receivedAt: "2026-07-24T13:30:00.200Z",
      price: 220.1,
      tradingAmount: 220.1,
      cumulativeVolume: 2,
      cumulativeAmount: 440.1,
      recordedAt: 2,
    });
    await repository.putTrades([sameProviderSecond, first, first]);

    expect(await repository.listTrades({
      marketCountry: "US",
      symbol: "tsla",
      sessionDate: "2026-07-24",
      from: "2026-07-24T13:30:00.000Z",
      to: "2026-07-24T13:30:00.000Z",
    })).toEqual([
      expect.objectContaining({
        eventId: first.eventId,
        exchange: "NAS",
        sessionFeed: "standard",
        executedAt: "2026-07-24T13:30:00.000Z",
        receivedAt: "2026-07-24T13:30:00.100Z",
        executionStrength: 101.5,
        bestBidPrice: 219.99,
      }),
      expect.objectContaining({
        eventId: sameProviderSecond.eventId,
        sessionFeed: "day",
        receivedAt: "2026-07-24T13:30:00.200Z",
        cumulativeAmount: 440.1,
      }),
    ]);
  });

  it("호가 JSON과 최우선 호가를 보존하고 같은 초 스냅샷을 수신 시각 순으로 반환한다", async () => {
    const repository = await setup();
    const first = orderbook({
      depth: "ten_level",
      asks: [{ price: 220.01, quantity: 2 }, { price: 220.02, quantity: 4 }],
      bids: [{ price: 219.99, quantity: 3 }, { price: 219.98, quantity: 5 }],
      totalAskQuantity: 6,
      totalBidQuantity: 8,
    });
    const second = orderbook({
      snapshotId: "00000000-0000-4000-8000-000000000002",
      receivedAt: "2026-07-24T13:30:00.200Z",
      asks: [{ price: 220.02, quantity: 1 }],
      bids: [{ price: 220, quantity: 2 }],
      bestAskPrice: 220.02,
      bestAskQuantity: 1,
      bestBidPrice: 220,
      bestBidQuantity: 2,
      recordedAt: 2,
    });
    await repository.putOrderbooks([second, first]);

    expect(await repository.listOrderbooks({
      marketCountry: "US",
      symbol: "TSLA",
      sessionDate: "2026-07-24",
    })).toEqual([
      expect.objectContaining({
        snapshotId: first.snapshotId,
        depth: "ten_level",
        asks: [{ price: 220.01, quantity: 2 }, { price: 220.02, quantity: 4 }],
        bids: [{ price: 219.99, quantity: 3 }, { price: 219.98, quantity: 5 }],
        totalAskQuantity: 6,
        bestAskPrice: 220.01,
      }),
      expect.objectContaining({
        snapshotId: second.snapshotId,
        receivedAt: "2026-07-24T13:30:00.200Z",
        bestBidPrice: 220,
      }),
    ]);
  });

  it("종목별 공백과 전체 운영 이벤트를 JSON 세부정보와 함께 시간순으로 보존한다", async () => {
    const repository = await setup();
    const globalStart = recordingEvent({
      eventId: "00000000-0000-4000-8000-000000000011",
      symbol: undefined,
      eventType: "recorder_started",
      occurredAt: "2026-07-24T13:00:00.000Z",
      code: undefined,
      details: { instruments: 9 },
      recordedAt: 1,
    });
    const gap = recordingEvent();
    const diagnostic = recordingEvent({
      eventId: "00000000-0000-4000-8000-000000000012",
      eventType: "diagnostic",
      code: "recovery-completed",
      details: null,
      recordedAt: 11,
    });
    await repository.putRecordingEvents([diagnostic, globalStart, gap, gap]);

    expect(await repository.listRecordingEvents({
      marketCountry: "US",
      symbol: null,
    })).toEqual([
      expect.objectContaining({
        eventId: globalStart.eventId,
        eventType: "recorder_started",
        details: { instruments: 9 },
      }),
    ]);
    expect(await repository.listRecordingEvents({
      marketCountry: "US",
      symbol: "tsla",
      from: "2026-07-24T13:30:00.000Z",
      to: "2026-07-24T13:30:00.000Z",
    })).toEqual([
      expect.objectContaining({
        eventId: gap.eventId,
        eventType: "data_gap",
        code: "trade-feed-silence",
        details: { feed: "standard", gapMs: 15_000 },
      }),
      expect.objectContaining({
        eventId: diagnostic.eventId,
        eventType: "diagnostic",
        details: null,
      }),
    ]);
    expect(await repository.listRecordingEvents({
      marketCountry: "US",
      eventTypes: ["data_gap"],
    })).toHaveLength(1);
  });

  it("원본 체결과 호가의 식별자·시각·유한값·호가 순서를 검증한다", async () => {
    const repository = await setup();
    await expect(repository.putTrades([trade({ eventId: "invalid event id" })]))
      .rejects.toThrow("eventId");
    await expect(repository.putTrades([trade({ executedAt: "2026-07-24T13:30:00" })]))
      .rejects.toThrow("RFC3339");
    await expect(repository.putTrades([trade({ executionStrength: Number.NaN })]))
      .rejects.toThrow("executionStrength");
    await expect(repository.putOrderbooks([orderbook({
      asks: [{ price: 220.02, quantity: 1 }, { price: 220.01, quantity: 2 }],
      bestAskPrice: 220.02,
      bestAskQuantity: 1,
    })])).rejects.toThrow("정렬");
    await expect(repository.putOrderbooks([orderbook({
      snapshotId: "not-a-uuid",
    })])).rejects.toThrow("UUID");
    await expect(repository.putOrderbooks([orderbook({
      bestAskPrice: 221,
    })])).rejects.toThrow("최우선 호가");
  });

  it("운영 이벤트의 UUID·유형·시각·코드·JSON 크기를 검증한다", async () => {
    const repository = await setup();
    await expect(repository.putRecordingEvents([recordingEvent({ eventId: "not-a-uuid" })]))
      .rejects.toThrow("UUID");
    await expect(repository.putRecordingEvents([recordingEvent({ eventType: "other" as never })]))
      .rejects.toThrow("eventType");
    await expect(repository.putRecordingEvents([recordingEvent({ occurredAt: "2026-07-24T13:30:00" })]))
      .rejects.toThrow("RFC3339");
    await expect(repository.putRecordingEvents([recordingEvent({ code: "invalid code" })]))
      .rejects.toThrow("code");
    await expect(repository.putRecordingEvents([recordingEvent({ details: { invalid: Number.NaN } })]))
      .rejects.toThrow("유한한");
    await expect(repository.putRecordingEvents([recordingEvent({ details: "x".repeat(65_536) })]))
      .rejects.toThrow("64KiB");
  });

  it("원본 체결을 500행 단위로 제한하고 MySQL/PostgreSQL 중복 무시 구문을 사용한다", async () => {
    const postgresRun = vi.fn().mockResolvedValue({ affectedRows: 500, insertId: 0 });
    const postgresTransactionDatabase = {
      dialect: "postgres" as const,
      run: postgresRun,
      query: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const postgresTransaction = vi.fn(
      async (work: (target: RelationalDatabase) => Promise<unknown>) => work(postgresTransactionDatabase),
    );
    const postgres = {
      dialect: "postgres" as const,
      run: vi.fn(),
      query: vi.fn(),
      transaction: postgresTransaction,
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    await new ScalpingRepository(postgres).putTrades(Array.from({ length: 1_001 }, (_, index) => trade({
      eventId: `kis:HDFSCNT0:standard:NAS:TSLA:${index}`,
      recordedAt: index,
    })));

    expect(postgresTransaction).toHaveBeenCalledOnce();
    expect(postgresRun).toHaveBeenCalledTimes(3);
    expect(postgresRun.mock.calls.every(([, parameters]) => (parameters as unknown[]).length <= 10_500))
      .toBe(true);
    expect(String(postgresRun.mock.calls[0]?.[0])).toContain(
      "ON CONFLICT(market_country, symbol, event_id) DO NOTHING",
    );

    const mysqlRun = vi.fn().mockResolvedValue({ affectedRows: 1, insertId: 0 });
    const mysql = {
      dialect: "mysql" as const,
      run: mysqlRun,
      query: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    await new ScalpingRepository(mysql).putTrades([trade()]);
    expect(String(mysqlRun.mock.calls[0]?.[0])).toContain("INSERT IGNORE INTO portfolio_scalping_trades");
  });

  it("운영 이벤트도 500행 단위 batch와 PostgreSQL 중복 무시를 사용한다", async () => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 500, insertId: 0 });
    const transactionDatabase = {
      dialect: "postgres" as const,
      run,
      query: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    const transaction = vi.fn(
      async (work: (target: RelationalDatabase) => Promise<unknown>) => work(transactionDatabase),
    );
    const postgres = {
      dialect: "postgres" as const,
      run: vi.fn(),
      query: vi.fn(),
      transaction,
      close: vi.fn(),
    } as unknown as RelationalDatabase;
    await new ScalpingRepository(postgres).putRecordingEvents(
      Array.from({ length: 501 }, (_, index) => recordingEvent({
        eventId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        recordedAt: index,
      })),
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([, parameters]) => (parameters as unknown[]).length <= 4_000)).toBe(true);
    expect(String(run.mock.calls[0]?.[0])).toContain("INTO portfolio_scalping_recording_events");
    expect(String(run.mock.calls[0]?.[0])).toContain("ON CONFLICT(event_id) DO NOTHING");
  });

  it("live와 retrospective 예측을 구분하고 모델 provenance를 보존한다", async () => {
    const repository = await setup();
    const input = {
      symbol: "005930",
      modelName: "NeoQuasar/Kronos-base",
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
      modelName: "NeoQuasar/Kronos-base",
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
