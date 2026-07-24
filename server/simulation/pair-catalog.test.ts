import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIR_CATALOG,
  PAIR_CATALOG_VERSION,
  createPairCatalog,
  getPairCatalogEntry,
  mapPairDirection,
  validatePairCatalogEntry,
} from "./pair-catalog.js";
import { SimulationPairIdSchema } from "./contracts.js";

describe("pair catalog", () => {
  it("contains the versioned supported mappings with explicit leverage", () => {
    expect([...DEFAULT_PAIR_CATALOG.keys()]).toEqual([
      "qqq-tqqq-sqqq",
      "smh-soxl-soxs",
      "soxx-soxl-soxs",
      "tsla-tsll-tslq",
      "tsla-tsll-tsls",
    ]);
    expect(getPairCatalogEntry(" SOXX-SOXL-SOXS ")).toMatchObject({
      signalSymbol: "SOXX",
      bull: { executionSymbol: "SOXL", leverageMultiplier: 3 },
      bear: { executionSymbol: "SOXS", leverageMultiplier: -3 },
    });
    expect(getPairCatalogEntry("tsla-tsll-tsls").bear.leverageMultiplier).toBe(-1);
    expect(getPairCatalogEntry("tsla-tsll-tslq").bear.leverageMultiplier).toBe(-2);
    expect([...SimulationPairIdSchema.options].sort()).toEqual(
      [...DEFAULT_PAIR_CATALOG.keys()].sort(),
    );
  });

  it("maps signal and execution symbols without inventing a cash instrument", () => {
    const pair = getPairCatalogEntry("qqq-tqqq-sqqq");
    expect(mapPairDirection(pair, "bull")).toEqual({
      pairId: pair.pairId,
      signalSymbol: "QQQ",
      direction: "bull",
      executionSymbol: "TQQQ",
      leverageMultiplier: 3,
    });
    expect(mapPairDirection(pair, "cash")).toEqual({
      pairId: pair.pairId,
      signalSymbol: "QQQ",
      direction: "cash",
      executionSymbol: null,
      leverageMultiplier: 0,
    });
  });

  it("strictly rejects malformed, ambiguous, and duplicate entries", () => {
    const valid = {
      catalogVersion: PAIR_CATALOG_VERSION,
      pairId: "abc-bull-bear",
      marketCountry: "US",
      currency: "USD",
      signalSymbol: " abc ",
      bull: { executionSymbol: " bull ", leverageMultiplier: 2 },
      bear: { executionSymbol: "bear", leverageMultiplier: -2 },
      allowedSessions: ["regular"],
      maxSpreadBps: 25,
    };
    expect(validatePairCatalogEntry(valid)).toMatchObject({
      signalSymbol: "ABC",
      bull: { executionSymbol: "BULL" },
    });
    expect(() => validatePairCatalogEntry({ ...valid, unexpected: true })).toThrow();
    expect(() => validatePairCatalogEntry({
      ...valid,
      bull: { executionSymbol: "ABC", leverageMultiplier: 2 },
    })).toThrow(/distinct/);
    expect(() => validatePairCatalogEntry({
      ...valid,
      bear: { executionSymbol: "BEAR", leverageMultiplier: 2 },
    })).toThrow(/negative/);
    expect(() => validatePairCatalogEntry({
      ...valid,
      allowedSessions: ["regular", "regular"],
    })).toThrow(/duplicates/);
    expect(() => createPairCatalog([valid, valid])).toThrow(/Duplicate/);
    expect(() => getPairCatalogEntry("missing")).toThrow(/Unknown/);
  });
});
