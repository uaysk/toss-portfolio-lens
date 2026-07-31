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
      "semiconductor-soxl-soxs",
      "smh-soxl-soxs",
      "sndk-snxx-sndq",
      "soxx-soxl-soxs",
      "spy-spxl-spxs",
      "tsla-tsll-tslq",
      "tsla-tsll-tsls",
    ]);
    expect(getPairCatalogEntry(" SOXX-SOXL-SOXS ")).toMatchObject({
      displaySignalSymbol: "SOXX",
      modelTargetSymbol: "SOXX",
      auxiliarySymbols: [],
      bull: { executionSymbol: "SOXL", leverageMultiplier: 3 },
      bear: { executionSymbol: "SOXS", leverageMultiplier: -3 },
    });
    expect(getPairCatalogEntry("semiconductor-soxl-soxs")).toMatchObject({
      displaySignalSymbol: "SMH",
      modelTargetSymbol: "SOXX",
      auxiliarySymbols: ["SMH", "QQQ"],
    });
    expect(getPairCatalogEntry("spy-spxl-spxs")).toMatchObject({
      modelTargetSymbol: "SPY",
      bull: { executionSymbol: "SPXL" },
      bear: { executionSymbol: "SPXS" },
    });
    expect(getPairCatalogEntry("tsla-tsll-tsls").bear.leverageMultiplier).toBe(-1);
    expect(getPairCatalogEntry("tsla-tsll-tslq").bear.leverageMultiplier).toBe(-2);
    expect(getPairCatalogEntry("sndk-snxx-sndq")).toMatchObject({
      displaySignalSymbol: "SNDK",
      modelTargetSymbol: "SNDK",
      bull: { executionSymbol: "SNXX", leverageMultiplier: 2 },
      bear: { executionSymbol: "SNDQ", leverageMultiplier: -2 },
      selectionProvenance: {
        verifiedAt: "2026-07-25",
      },
    });
    expect([...SimulationPairIdSchema.options].sort()).toEqual(
      [...DEFAULT_PAIR_CATALOG.keys()].sort(),
    );
  });

  it("maps signal and execution symbols without inventing a cash instrument", () => {
    const pair = getPairCatalogEntry("qqq-tqqq-sqqq");
    expect(mapPairDirection(pair, "bull")).toEqual({
      pairId: pair.pairId,
      displaySignalSymbol: "QQQ",
      modelTargetSymbol: "QQQ",
      auxiliarySymbols: [],
      direction: "bull",
      executionSymbol: "TQQQ",
      leverageMultiplier: 3,
    });
    expect(mapPairDirection(pair, "cash")).toEqual({
      pairId: pair.pairId,
      displaySignalSymbol: "QQQ",
      modelTargetSymbol: "QQQ",
      auxiliarySymbols: [],
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
      displaySignalSymbol: " abc ",
      modelTargetSymbol: " abc ",
      auxiliarySymbols: [],
      bull: { executionSymbol: " bull ", leverageMultiplier: 2 },
      bear: { executionSymbol: "bear", leverageMultiplier: -2 },
      allowedSessions: ["regular"],
      maxSpreadBps: 25,
    };
    expect(validatePairCatalogEntry(valid)).toMatchObject({
      catalogVersion: PAIR_CATALOG_VERSION,
      displaySignalSymbol: "ABC",
      modelTargetSymbol: "ABC",
      auxiliarySymbols: [],
      bull: { executionSymbol: "BULL" },
    });
    expect(() => validatePairCatalogEntry({
      ...valid,
      catalogVersion: "scalping-pair-catalog/v2",
    })).toThrow();
    expect(() => validatePairCatalogEntry({
      ...valid,
      signalSymbol: "ABC",
    })).toThrow();
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
