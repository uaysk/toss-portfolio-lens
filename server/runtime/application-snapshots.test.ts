import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationSnapshotOrchestrator } from "./application-snapshots.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ApplicationSnapshotOrchestrator", () => {
  it("초기 스냅샷 뒤 backfill을 실행하고 refresh 주기로 다시 수집한다", async () => {
    vi.useFakeTimers();
    const collectAccount = vi.fn(async () => undefined);
    const runBackfill = vi.fn(async () => undefined);
    const orchestrator = new ApplicationSnapshotOrchestrator({
      getAccountIds: async () => ["account-a", "account-b"],
      collectAccount,
      runBackfill,
      refreshIntervalMs: 10_000,
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(collectAccount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(collectAccount.mock.calls).toEqual([["account-a"], ["account-b"]]);
    expect(runBackfill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(collectAccount).toHaveBeenCalledTimes(4);
    expect(runBackfill).toHaveBeenCalledTimes(1);

    orchestrator.stopScheduling();
  });

  it("겹친 수집 요청을 하나의 작업으로 합치고 종료 시 진행 중 작업을 기다린다", async () => {
    let releaseAccounts!: (accountIds: readonly string[]) => void;
    const accountIds = new Promise<readonly string[]>((resolve) => {
      releaseAccounts = resolve;
    });
    const getAccountIds = vi.fn(() => accountIds);
    const collectAccount = vi.fn(async () => undefined);
    const orchestrator = new ApplicationSnapshotOrchestrator({
      getAccountIds,
      collectAccount,
      runBackfill: async () => undefined,
      refreshIntervalMs: 10_000,
    });

    const first = orchestrator.collectDailySnapshots();
    const second = orchestrator.collectDailySnapshots();
    orchestrator.stopScheduling();
    const idle = orchestrator.waitForIdle();

    expect(second).toBe(first);
    expect(idle).toBe(first);
    expect(getAccountIds).toHaveBeenCalledTimes(1);

    releaseAccounts(["account-a"]);
    await idle;
    expect(collectAccount).toHaveBeenCalledWith("account-a");
    await expect(orchestrator.collectDailySnapshots()).resolves.toBeUndefined();
    expect(getAccountIds).toHaveBeenCalledTimes(1);
  });

  it("계좌별 실패는 다음 계좌 수집을 막지 않고 기존 로그 계약을 유지한다", async () => {
    const warn = vi.fn();
    const collectAccount = vi.fn(async (accountId: string) => {
      if (accountId === "account-a") throw new Error("portfolio failed");
    });
    const orchestrator = new ApplicationSnapshotOrchestrator({
      getAccountIds: async () => ["account-a", "account-b"],
      collectAccount,
      runBackfill: async () => undefined,
      refreshIntervalMs: 10_000,
      warn,
    });

    await orchestrator.collectDailySnapshots();

    expect(collectAccount.mock.calls).toEqual([["account-a"], ["account-b"]]);
    expect(warn).toHaveBeenCalledWith(
      "[history] account-a 계좌 수집 실패:",
      "portfolio failed",
    );
  });

  it("계좌 목록과 초기 backfill 실패 로그 계약을 유지한다", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const orchestrator = new ApplicationSnapshotOrchestrator({
      getAccountIds: async () => {
        throw new Error("accounts failed");
      },
      collectAccount: async () => undefined,
      runBackfill: async () => {
        throw new Error("backfill failed");
      },
      refreshIntervalMs: 10_000,
      warn,
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[history] 계좌 목록 수집 실패:",
      "accounts failed",
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "[backfill] 초기 동기화 시작 실패:",
      "backfill failed",
    );
    orchestrator.stopScheduling();
  });

  it("스케줄 중지는 대기 중인 초기·주기 수집을 취소한다", async () => {
    vi.useFakeTimers();
    const getAccountIds = vi.fn(async () => ["account-a"]);
    const runBackfill = vi.fn(async () => undefined);
    const orchestrator = new ApplicationSnapshotOrchestrator({
      getAccountIds,
      collectAccount: async () => undefined,
      runBackfill,
      refreshIntervalMs: 10_000,
    });

    orchestrator.start();
    orchestrator.stopScheduling();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(getAccountIds).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
    await expect(orchestrator.waitForIdle()).resolves.toBeUndefined();
  });
});
