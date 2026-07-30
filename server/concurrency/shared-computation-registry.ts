type SharedEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: Set<symbol>;
  settled: boolean;
};

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

  run<T>(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let entry = this.entries.get(key) as SharedEntry<T> | undefined;
    if (!entry) {
      const controller = new AbortController();
      const created: SharedEntry<T> = {
        controller,
        subscribers: new Set(),
        settled: false,
        promise: Promise.resolve().then(() => factory(controller.signal)),
      };
      entry = created;
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
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private settle<T>(key: string, entry: SharedEntry<T>): void {
    entry.settled = true;
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
