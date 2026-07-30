export type AnimationFrameScheduler = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
};

export function createAnimationFrameCoalescer<T>(
  scheduler: AnimationFrameScheduler,
  commit: (value: T) => void,
): {
  schedule: (value: T) => void;
  cancel: () => void;
} {
  let frame: number | undefined;
  let pending: T | undefined;
  let hasPending = false;
  return {
    schedule(value) {
      pending = value;
      hasPending = true;
      if (frame !== undefined) return;
      frame = scheduler.request(() => {
        frame = undefined;
        if (!hasPending) return;
        hasPending = false;
        commit(pending as T);
      });
    },
    cancel() {
      if (frame !== undefined) scheduler.cancel(frame);
      frame = undefined;
      pending = undefined;
      hasPending = false;
    },
  };
}

export function groupByNormalizedSymbol<T>(
  values: readonly T[],
  symbolOf: (value: T) => string | undefined,
): ReadonlyMap<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const symbol = symbolOf(value)?.trim().toUpperCase();
    if (!symbol) continue;
    const bucket = grouped.get(symbol);
    if (bucket) bucket.push(value);
    else grouped.set(symbol, [value]);
  }
  return grouped;
}
