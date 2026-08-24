type SharedEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: Set<symbol>;
  settled: boolean;
};

const DEFAULT_MAXIMUM_ENTRIES = 32;

export class SharedComputationCapacityError extends Error {
  readonly retryAfterSeconds = 1;

  constructor(readonly maximumEntries: number) {
    super("공유 계산 처리 용량이 가득 찼습니다. 잠시 후 다시 시도해 주세요.");
    this.name = "SharedComputationCapacityError";
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("공유 계산 구독이 취소되었습니다.");
}

/**
 * Shares one upstream computation between equivalent callers without sharing
 * their cancellation. The upstream work is cancelled only after its last
 * subscriber leaves.
 */
export class SharedComputationRegistry {
  private readonly entries = new Map<string, SharedEntry<unknown>>();
  private readonly maximumEntries: number;
  private activeComputations = 0;
  private closedReason?: Error;

  constructor(options: { maximumEntries?: number } = {}) {
    this.maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    if (!Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1) {
      throw new TypeError("Shared computation maximumEntries must be a positive safe integer.");
    }
  }

  run<T>(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let entry = this.entries.get(key) as SharedEntry<T> | undefined;
    if (!entry) {
      if (this.activeComputations >= this.maximumEntries) {
        return Promise.reject(new SharedComputationCapacityError(this.maximumEntries));
      }
      const controller = new AbortController();
      const created: SharedEntry<T> = {
        controller,
        subscribers: new Set(),
        settled: false,
        promise: Promise.resolve().then(() => factory(controller.signal)),
      };
      entry = created;
      this.activeComputations += 1;
      this.entries.set(key, created as SharedEntry<unknown>);
      created.promise.then(
        () => this.settle(key, created),
        () => this.settle(key, created),
      );
    }

    const subscriber = Symbol(key);
    entry.subscribers.add(subscriber);
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        this.unsubscribe(key, entry!, subscriber);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      entry!.promise.then(
        (value) => {
          if (!finish()) return;
          resolve(value);
        },
        (error: unknown) => {
          if (!finish()) return;
          reject(error);
        },
      );
    });
  }

  close(reason = new Error("공유 계산 레지스트리가 종료되었습니다.")): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    }
    this.entries.clear();
  }

  get size(): number {
    return this.activeComputations;
  }

  private settle<T>(key: string, entry: SharedEntry<T>): void {
    if (entry.settled) return;
    entry.settled = true;
    this.activeComputations -= 1;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private unsubscribe<T>(key: string, entry: SharedEntry<T>, subscriber: symbol): void {
    entry.subscribers.delete(subscriber);
    if (entry.settled || entry.subscribers.size > 0) return;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error("공유 계산의 마지막 구독이 종료되었습니다."));
    }
  }
}
