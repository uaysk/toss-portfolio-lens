import type { IntradayBarRecord } from "../repositories/scalping-repository.js";

type QueuedBar = {
  record: IntradayBarRecord;
  queuedAt: number;
};

export type BarWriteBufferSnapshot = {
  queueDepth: number;
  oldestAgeMs: number;
  coalescedTotal: number;
  rejectedTotal: number;
  writtenTotal: number;
  flushesTotal: number;
};

export type BarWriteBufferOptions = {
  maximumEntries?: number;
  batchSize?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

function barKey(record: IntradayBarRecord): string {
  return [
    record.marketCountry ?? "KR",
    record.symbol,
    record.intervalMinutes,
    record.openTime,
  ].join(":");
}

function preferred(
  existing: IntradayBarRecord,
  incoming: IntradayBarRecord,
): IntradayBarRecord {
  if (existing.state === "final" && incoming.state !== "final") return existing;
  if (incoming.state === "final" && existing.state !== "final") return incoming;
  return incoming.updatedAt >= existing.updatedAt ? incoming : existing;
}

export class BarWriteBuffer {
  private readonly queued = new Map<string, QueuedBar>();
  private readonly maximumEntries: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;
  private coalescedTotal = 0;
  private rejectedTotal = 0;
  private writtenTotal = 0;
  private flushesTotal = 0;

  constructor(
    private readonly write: (records: readonly IntradayBarRecord[]) => Promise<void>,
    options: BarWriteBufferOptions = {},
  ) {
    this.maximumEntries = options.maximumEntries ?? 2_048;
    this.batchSize = options.batchSize ?? 256;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    if (!Number.isInteger(this.maximumEntries) || this.maximumEntries < 1) {
      throw new Error("bar write buffer maximumEntries must be a positive integer");
    }
    if (!Number.isInteger(this.batchSize)
      || this.batchSize < 1
      || this.batchSize > this.maximumEntries) {
      throw new Error("bar write buffer batchSize must be in 1..=maximumEntries");
    }
  }

  enqueue(records: readonly IntradayBarRecord[]): boolean {
    let accepted = true;
    for (const record of records) {
      const key = barKey(record);
      const current = this.queued.get(key);
      if (current) {
        current.record = preferred(current.record, record);
        this.coalescedTotal += 1;
        continue;
      }
      if (this.queued.size >= this.maximumEntries) {
        const formingKey = [...this.queued]
          .find(([, value]) => value.record.state !== "final")?.[0];
        if (record.state === "final" && formingKey) {
          this.queued.delete(formingKey);
          this.rejectedTotal += 1;
        } else {
          this.rejectedTotal += 1;
          accepted = false;
          continue;
        }
      }
      this.queued.set(key, { record, queuedAt: this.now() });
    }
    if (this.queued.size > 0) void this.drain();
    return accepted;
  }

  snapshot(): BarWriteBufferSnapshot {
    const oldest = [...this.queued.values()]
      .reduce((value, item) => Math.min(value, item.queuedAt), Number.POSITIVE_INFINITY);
    return {
      queueDepth: this.queued.size,
      oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, this.now() - oldest) : 0,
      coalescedTotal: this.coalescedTotal,
      rejectedTotal: this.rejectedTotal,
      writtenTotal: this.writtenTotal,
      flushesTotal: this.flushesTotal,
    };
  }

  waitForIdle(): Promise<void> {
    if (!this.draining && this.queued.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queued.size > 0) {
        const batch = [...this.queued.entries()]
          .sort(([, left], [, right]) => (
            Number(right.record.state === "final") - Number(left.record.state === "final")
            || left.queuedAt - right.queuedAt
          ))
          .slice(0, this.batchSize);
        for (const [key] of batch) this.queued.delete(key);
        const records = batch.map(([, value]) => value.record);
        try {
          await this.write(records);
          this.writtenTotal += records.length;
          this.flushesTotal += 1;
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.draining = false;
      if (this.queued.size > 0) {
        void this.drain();
        return;
      }
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
}
