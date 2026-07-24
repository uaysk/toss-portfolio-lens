import { describe, expectTypeOf, it } from "vitest";
import type {
  AdvancedRunError,
  AdvancedRunSnapshot,
  BacktestResult,
  CompletedAdvancedRunSnapshot,
  Portfolio,
} from "../types";

describe("public type barrel", () => {
  it("keeps existing domain exports available from @/types", () => {
    expectTypeOf<Portfolio["holdings"]>().toBeArray();
    expectTypeOf<BacktestResult["warnings"]>().toEqualTypeOf<string[]>();
  });

  it("narrows run payloads and failures by status", () => {
    expectTypeOf<Extract<AdvancedRunSnapshot, { status: "running" }>["result"]>()
      .toEqualTypeOf<undefined>();
    expectTypeOf<Extract<AdvancedRunSnapshot, { status: "completed" }>>()
      .toEqualTypeOf<CompletedAdvancedRunSnapshot>();
    expectTypeOf<Extract<AdvancedRunSnapshot, { status: "failed" }>["error"]>()
      .toEqualTypeOf<AdvancedRunError | undefined>();
    expectTypeOf<Extract<AdvancedRunSnapshot, { status: "cancelled" }>["result"]>()
      .toEqualTypeOf<undefined>();
  });
});
