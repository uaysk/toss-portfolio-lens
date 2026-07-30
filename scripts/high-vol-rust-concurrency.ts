export type OrderedBatchResult<T> = {
  index: number;
  value: T;
};

export function boundedConcurrency(
  value: number,
  minimum = 1,
  maximum = 32,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Concurrency must be an integer in [${minimum}, ${maximum}].`);
  }
  return value;
}

/**
 * Runs at most `concurrency` work items at once and commits completed batches in
 * the original input order. A failed batch is never partially committed.
 */
export async function processInOrderedBatches<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
  commit: (results: readonly OrderedBatchResult<U>[]) => Promise<void>,
): Promise<void> {
  const bounded = boundedConcurrency(concurrency);
  for (let start = 0; start < values.length; start += bounded) {
    const batch = values.slice(start, start + bounded);
    const mapped = await Promise.all(batch.map(async (value, offset) => ({
      index: start + offset,
      value: await mapper(value, start + offset),
    })));
    await commit(mapped);
  }
}

/**
 * Recovers an append-only JSONL checkpoint when only its final record was
 * interrupted. Invalid records before the final non-empty line remain fatal.
 */
export function parseRecoverableJsonLines<T>(source: string): T[] {
  const lines = source.split("\n");
  const finalNonEmptyIndex = lines.findLastIndex((line) => line.trim().length > 0);
  const parsed: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      parsed.push(JSON.parse(line) as T);
    } catch (error) {
      if (index === finalNonEmptyIndex) break;
      throw error;
    }
  }
  return parsed;
}
