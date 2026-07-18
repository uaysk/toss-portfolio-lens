import { describe, expect, it } from "vitest";
import { combineDataRevisions } from "./return-series-service.js";
import { WorkerInputSchema } from "../worker/contracts.js";

describe("return series data revision", () => {
  it.each([2, 20])("%i종목 revision을 worker 계약의 64자 해시로 축약한다", (count) => {
    const revisions = Array.from({ length: count }, (_, index) => String(index).padStart(64, "a"));
    const combined = combineDataRevisions(revisions);
    expect(combined).toMatch(/^[a-f0-9]{64}$/);
    expect(combineDataRevisions([...revisions].reverse())).toBe(combined);
    expect(WorkerInputSchema.safeParse({
      schema_version: "1.0",
      engine_version: "portfolio-lens-rust-2026.07.2",
      run_id: "run-1",
      job_kind: "optimization",
      data_revision: combined,
      request_hash: "b".repeat(64),
      payload: {},
    }).success).toBe(true);
  });

  it("revision 하나가 바뀌면 결합 해시도 바뀐다", () => {
    expect(combineDataRevisions(["a".repeat(64), "b".repeat(64)]))
      .not.toBe(combineDataRevisions(["a".repeat(64), "c".repeat(64)]));
  });
});
