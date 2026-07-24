import { describe, expect, it } from "vitest";
import {
  createPairRuntimeState,
  transitionPairState,
  validatePairMutualExclusion,
} from "./pair-state.js";
import {
  DEFAULT_PAIR_CATALOG,
  getPairCatalogEntry,
} from "./pair-catalog.js";

const pair = getPairCatalogEntry("tsla-tsll-tslq");
const DECIDED = "2026-07-24T14:30:05.000Z";
const ELIGIBLE = "2026-07-24T14:30:06.000Z";

describe("pair runtime state", () => {
  it("rejects simultaneous bull and bear holdings", () => {
    expect(() => validatePairMutualExclusion(pair, {
      TSLL: 10,
      TSLQ: 5,
    })).toThrow(/cannot hold bull and bear simultaneously/);
    expect(validatePairMutualExclusion(pair, { TSLL: 10, TSLQ: 0 })).toBe("bull");
  });

  it("activates a direction only after its strictly later buy fill", () => {
    const initial = createPairRuntimeState(pair);
    const planned = transitionPairState(initial, {
      type: "decision",
      targetDirection: "bull",
      decidedAt: DECIDED,
      eligibleAfter: ELIGIBLE,
    }, DEFAULT_PAIR_CATALOG);
    expect(planned.state.direction).toBe("cash");
    expect(planned.commands).toEqual([{
      side: "buy",
      direction: "bull",
      executionSymbol: "TSLL",
      eligibleAfter: ELIGIBLE,
    }]);
    const sameTime = transitionPairState(planned.state, {
      type: "fill",
      side: "buy",
      direction: "bull",
      executionSymbol: "TSLL",
      executedAt: ELIGIBLE,
      cooldownMs: 300_000,
    }, DEFAULT_PAIR_CATALOG);
    expect(sameTime.status).toBe("blocked");
    const filled = transitionPairState(planned.state, {
      type: "fill",
      side: "buy",
      direction: "bull",
      executionSymbol: "TSLL",
      executedAt: "2026-07-24T14:30:07.000Z",
      cooldownMs: 300_000,
    }, DEFAULT_PAIR_CATALOG);
    expect(filled.state).toMatchObject({
      direction: "bull",
      executionSymbol: "TSLL",
      transitionCount: 1,
    });
  });

  it("serializes a bull-to-bear switch through cash and cooldown", () => {
    const held = createPairRuntimeState(pair, { TSLL: 10 }, "2026-07-24T14:25:00.000Z");
    const exit = transitionPairState(held, {
      type: "decision",
      targetDirection: "bear",
      decidedAt: DECIDED,
      eligibleAfter: ELIGIBLE,
    }, DEFAULT_PAIR_CATALOG);
    expect(exit.state.direction).toBe("bull");
    expect(exit.commands).toHaveLength(1);
    expect(exit.commands[0]).toMatchObject({ side: "sell", executionSymbol: "TSLL" });

    const exited = transitionPairState(exit.state, {
      type: "fill",
      side: "sell",
      direction: "bull",
      executionSymbol: "TSLL",
      executedAt: "2026-07-24T14:30:07.000Z",
      cooldownMs: 300_000,
    }, DEFAULT_PAIR_CATALOG);
    expect(exited.state).toMatchObject({
      direction: "cash",
      executionSymbol: null,
      cooldownUntil: "2026-07-24T14:35:07.000Z",
    });
    expect(exited.commands).toEqual([]);

    const blocked = transitionPairState(exited.state, {
      type: "decision",
      targetDirection: "bear",
      decidedAt: "2026-07-24T14:34:00.000Z",
      eligibleAfter: "2026-07-24T14:34:01.000Z",
    }, DEFAULT_PAIR_CATALOG);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reasonCodes).toContain("cooldown_active");

    const entry = transitionPairState(exited.state, {
      type: "decision",
      targetDirection: "bear",
      decidedAt: "2026-07-24T14:36:00.000Z",
      eligibleAfter: "2026-07-24T14:36:01.000Z",
    }, DEFAULT_PAIR_CATALOG);
    expect(entry.commands[0]).toMatchObject({ side: "buy", executionSymbol: "TSLQ" });
    expect(entry.state.direction).toBe("cash");
  });

  it("does not let repeated sideways decisions duplicate or reverse a pending transition", () => {
    const held = createPairRuntimeState(pair, { TSLL: 1 }, "2026-07-24T14:25:00.000Z");
    const first = transitionPairState(held, {
      type: "decision",
      targetDirection: "cash",
      decidedAt: DECIDED,
      eligibleAfter: ELIGIBLE,
    }, DEFAULT_PAIR_CATALOG);
    const repeated = transitionPairState(first.state, {
      type: "decision",
      targetDirection: "bull",
      decidedAt: "2026-07-24T14:30:08.000Z",
      eligibleAfter: "2026-07-24T14:30:09.000Z",
    }, DEFAULT_PAIR_CATALOG);
    expect(repeated.status).toBe("blocked");
    expect(repeated.commands).toEqual([]);
    expect(repeated.state.pending).toEqual(first.state.pending);
  });

  it("replaces a stale pending entry when the latest ensemble direction reverses", () => {
    const initial = createPairRuntimeState(pair);
    const bull = transitionPairState(initial, {
      type: "decision",
      targetDirection: "bull",
      decidedAt: DECIDED,
      eligibleAfter: ELIGIBLE,
    }, DEFAULT_PAIR_CATALOG);
    const bear = transitionPairState(bull.state, {
      type: "decision",
      targetDirection: "bear",
      decidedAt: "2026-07-24T14:30:08.000Z",
      eligibleAfter: "2026-07-24T14:30:09.000Z",
    }, DEFAULT_PAIR_CATALOG);
    expect(bear.status).toBe("applied");
    expect(bear.commands).toEqual([{
      side: "buy",
      direction: "bear",
      executionSymbol: "TSLQ",
      eligibleAfter: "2026-07-24T14:30:09.000Z",
    }]);
    expect(bear.reasonCodes).toContain("stale_pending_entry_replaced");
  });
});
