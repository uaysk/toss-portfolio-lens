export type DurationQuantiles = {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index]!;
}

export function durationQuantiles<T>(
  samples: readonly T[],
  valueOf: (sample: T) => number,
): DurationQuantiles {
  const sorted = samples.map(valueOf).sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    maxMs: rounded(sorted.at(-1) ?? 0),
  };
}
