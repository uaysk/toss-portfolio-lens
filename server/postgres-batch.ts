export const POSTGRES_BATCH_MAX_ROWS = 1_000;

/**
 * PostgreSQL rejects a single INSERT ... ON CONFLICT statement when two input
 * rows target the same key. Split before duplicates so the original row order
 * and last-write-wins behavior remain deterministic.
 */
export function postgresWriteBatches<T>(
  rows: readonly T[],
  conflictKey?: (row: T) => string,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let keys = new Set<string>();
  for (const row of rows) {
    const key = conflictKey?.(row);
    if (
      batch.length >= POSTGRES_BATCH_MAX_ROWS
      || (key !== undefined && keys.has(key))
    ) {
      batches.push(batch);
      batch = [];
      keys = new Set();
    }
    batch.push(row);
    if (key !== undefined) keys.add(key);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function postgresUnnestParameters(
  rows: readonly (readonly unknown[])[],
  columnCount: number,
): unknown[][] {
  if (columnCount <= 0 || rows.some((row) => row.length !== columnCount)) {
    throw new Error("PostgreSQL UNNEST batch column count mismatch");
  }
  return Array.from(
    { length: columnCount },
    (_, column) => rows.map((row) => row[column] ?? null),
  );
}
