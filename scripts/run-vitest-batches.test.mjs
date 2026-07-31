import assert from "node:assert/strict";
import test from "node:test";
import {
  HEAP_LIMIT_MB,
  classifyTestFile,
  memoryPlan,
  nodeOptionsWithHeapLimit,
  planBatches,
  positiveInteger,
} from "./run-vitest-batches.mjs";

test("classifies PGlite before crypto and isolates crypto or large tests as heavy", () => {
  assert.deepEqual(
    classifyTestFile("server/crypto/store.test.ts", "const database = new PGliteDatabase();"),
    { lane: "pglite", reason: "pglite-marker" },
  );
  assert.deepEqual(
    classifyTestFile("server/crypto/runtime.test.ts", "test('runtime', () => {});"),
    { lane: "heavy", reason: "heavy-path" },
  );
  assert.deepEqual(
    classifyTestFile("src/lib/light.test.ts", "test('light', () => {});"),
    { lane: "light", reason: "default" },
  );
  assert.deepEqual(
    classifyTestFile("src/lib/generated.test.ts", "x".repeat(64 * 1_024)),
    { lane: "heavy", reason: "large-test-file" },
  );
});

test("plans light batches for parallel execution and heavy/PGlite files one at a time", () => {
  const files = [
    { path: "a.test.ts", lane: "light" },
    { path: "b.test.ts", lane: "light" },
    { path: "c.test.ts", lane: "light" },
    { path: "crypto.test.ts", lane: "heavy" },
    { path: "database.test.ts", lane: "pglite" },
  ];
  assert.deepEqual(planBatches(files, "all", 2), [
    { ordinal: 1, name: "light-1", lane: "light", files: ["a.test.ts", "b.test.ts"] },
    { ordinal: 2, name: "light-2", lane: "light", files: ["c.test.ts"] },
    { ordinal: 3, name: "heavy-1", lane: "heavy", files: ["crypto.test.ts"] },
    { ordinal: 4, name: "pglite-1", lane: "pglite", files: ["database.test.ts"] },
  ]);
  assert.deepEqual(
    planBatches(files, "unit", 2).flatMap(({ files: batchFiles }) => batchFiles),
    ["a.test.ts", "b.test.ts", "c.test.ts", "crypto.test.ts"],
  );
  assert.deepEqual(
    planBatches(files, "pglite", 2).flatMap(({ files: batchFiles }) => batchFiles),
    ["database.test.ts"],
  );
});

test("caps light parallelism by the smaller detected or explicit memory budget", () => {
  assert.deepEqual(memoryPlan({
    detectedAvailableMb: 3_500,
    explicitBudgetMb: 4_096,
    requestedMaxParallel: 4,
  }), {
    detectedAvailableMb: 3_500,
    requestedBudgetMb: 4_096,
    explicitBudgetMb: 4_096,
    effectiveBudgetMb: 3_500,
    processReservationMb: 1_024,
    headroomMb: 512,
    requestedMaxParallel: 4,
    lightParallelism: 2,
  });
  assert.equal(memoryPlan({
    detectedAvailableMb: 8_000,
    explicitBudgetMb: 2_048,
    requestedMaxParallel: 3,
  }).lightParallelism, 1);
  assert.throws(() => positiveInteger("0", "memory budget"), /Invalid memory budget/u);
});

test("replaces inherited heap flags with the fixed 768MB child limit", () => {
  assert.equal(HEAP_LIMIT_MB, 768);
  assert.equal(
    nodeOptionsWithHeapLimit("--trace-warnings --max-old-space-size=2048"),
    "--trace-warnings --max-old-space-size=768",
  );
  assert.equal(
    nodeOptionsWithHeapLimit("--max_old_space_size 1024 --enable-source-maps"),
    "--enable-source-maps --max-old-space-size=768",
  );
});
