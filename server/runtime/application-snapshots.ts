export type ApplicationSnapshotOrchestratorOptions = {
  getAccountIds: () => Promise<readonly string[]>;
  collectAccount: (accountId: string) => Promise<void>;
  runBackfill: () => Promise<void>;
  refreshIntervalMs: number;
  initialDelayMs?: number;
  warn?: (...data: unknown[]) => void;
};

export class ApplicationSnapshotOrchestrator {
  private readonly initialDelayMs: number;
  private readonly warn: (...data: unknown[]) => void;
  private initialCollectionTimer?: NodeJS.Timeout;
  private collectionInterval?: NodeJS.Timeout;
  private activeSnapshotCollection?: Promise<void>;
  private schedulingStarted = false;
  private stopping = false;

  constructor(private readonly options: ApplicationSnapshotOrchestratorOptions) {
    if (!Number.isFinite(options.refreshIntervalMs) || options.refreshIntervalMs < 1) {
      throw new Error("Snapshot refresh interval must be a positive number.");
    }
    this.initialDelayMs = options.initialDelayMs ?? 2_000;
    if (!Number.isFinite(this.initialDelayMs) || this.initialDelayMs < 0) {
      throw new Error("Initial snapshot delay must be a non-negative number.");
    }
    this.warn = options.warn ?? console.warn;
  }

  start(): void {
    if (this.schedulingStarted || this.stopping) return;
    this.schedulingStarted = true;
    this.initialCollectionTimer = setTimeout(
      () => void this.collectInitialData(),
      this.initialDelayMs,
    );
    this.initialCollectionTimer.unref();
    this.collectionInterval = setInterval(
      () => void this.collectDailySnapshots(),
      this.options.refreshIntervalMs,
    );
    this.collectionInterval.unref();
  }

  stopScheduling(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.initialCollectionTimer) {
      clearTimeout(this.initialCollectionTimer);
      this.initialCollectionTimer = undefined;
    }
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = undefined;
    }
  }

  waitForIdle(): Promise<void> {
    return this.activeSnapshotCollection ?? Promise.resolve();
  }

  collectDailySnapshots(): Promise<void> {
    if (this.activeSnapshotCollection) return this.activeSnapshotCollection;
    if (this.stopping) return Promise.resolve();

    const task = (async () => {
      const accountIds = await this.options.getAccountIds();
      for (const accountId of accountIds) {
        try {
          await this.options.collectAccount(accountId);
        } catch (error) {
          this.warn(
            "[history] " + accountId + " 계좌 수집 실패:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    })().catch((error) => {
      this.warn(
        "[history] 계좌 목록 수집 실패:",
        error instanceof Error ? error.message : error,
      );
    });
    const trackedTask = task.finally(() => {
      if (this.activeSnapshotCollection === trackedTask) {
        this.activeSnapshotCollection = undefined;
      }
    });
    this.activeSnapshotCollection = trackedTask;
    return trackedTask;
  }

  private async collectInitialData(): Promise<void> {
    await this.collectDailySnapshots();
    if (this.stopping) return;
    try {
      await this.options.runBackfill();
    } catch (error) {
      this.warn(
        "[backfill] 초기 동기화 시작 실패:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
