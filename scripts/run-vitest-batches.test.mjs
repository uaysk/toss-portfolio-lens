import assert from "node:assert/strict";
import test from "node:test";
import {
  HEAP_LIMIT_MB,
  PGLITE_PROCESS_RESERVATION_MB,
  classifyTestFile,
  isSerialBatch,
  memoryPlan,
  nodeOptionsWithHeapLimit,
  parseSerialFiles,
  planBatches,
  planPgliteGroups,
  positiveInteger,
  vitestArguments,
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
  assert.deepEqual(planBatches(files, "light", 2), [
    { ordinal: 1, name: "light-1", lane: "light", files: ["a.test.ts", "b.test.ts"] },
    { ordinal: 2, name: "light-2", lane: "light", files: ["c.test.ts"] },
  ]);
  assert.deepEqual(planBatches(files, "heavy", 2), [
    { ordinal: 1, name: "heavy-1", lane: "heavy", files: ["crypto.test.ts"] },
  ]);
  assert.deepEqual(
    planBatches(files, "pglite", 2).flatMap(({ files: batchFiles }) => batchFiles),
    ["database.test.ts"],
  );
  assert.deepEqual(planBatches(files, "unknown", 2), []);
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
    pgliteProcessReservationMb: PGLITE_PROCESS_RESERVATION_MB,
    headroomMb: 512,
    requestedMaxParallel: 4,
    requestedPgliteParallel: 1,
    lightParallelism: 2,
    pgliteParallelism: 1,
  });
  assert.equal(memoryPlan({
    detectedAvailableMb: 8_000,
    explicitBudgetMb: 2_048,
    requestedMaxParallel: 3,
  }).lightParallelism, 1);
  assert.throws(() => positiveInteger("0", "memory budget"), /Invalid memory budget/u);
});

test("bounds PGlite parallelism by its larger process reservation", () => {
  const result = memoryPlan({
    detectedAvailableMb: 4_096,
    explicitBudgetMb: 4_096,
    requestedMaxParallel: 2,
    requestedPgliteParallel: 3,
  });
  assert.equal(result.pgliteParallelism, 2);
  assert.equal(result.pgliteProcessReservationMb, 1_536);
});

test("groups PGlite batches in bounded pairs while isolating known high-memory files", () => {
  const batches = [1, 2, 3, 4].map((ordinal) => ({
    ordinal,
    name: `pglite-${ordinal}`,
    lane: "pglite",
    files: [`server/test-${ordinal}.test.ts`],
  }));
  const serialFiles = parseSerialFiles(" server/test-3.test.ts ");
  assert.equal(isSerialBatch(batches[2], serialFiles), true);
  assert.deepEqual(
    planPgliteGroups(batches, serialFiles, 2).map((group) => group.map(({ ordinal }) => ordinal)),
    [[1, 2], [3], [4]],
  );
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

test("adds isolated JUnit and coverage outputs without increasing Vitest workers", () => {
  const arguments_ = vitestArguments(
    { name: "light-2", files: ["src/example.test.ts"] },
    {
      junitDirectory: "/tmp/toss-vitest-junit",
      coverageDirectory: "/tmp/toss-vitest-coverage",
    },
  );
  assert.ok(arguments_.includes("--maxWorkers=1"));
  assert.ok(arguments_.includes("--no-file-parallelism"));
  assert.ok(arguments_.includes("--reporter=junit"));
  assert.ok(arguments_.includes(
    "--outputFile.junit=/tmp/toss-vitest-junit/light-2.xml",
  ));
  assert.ok(arguments_.includes("--coverage.provider=v8"));
  assert.ok(arguments_.includes("--coverage.all=false"));
  assert.ok(arguments_.includes("--coverage.reporter=json"));
  assert.ok(arguments_.includes(
    "--coverage.reportsDirectory=/tmp/toss-vitest-coverage/light-2",
  ));
});
