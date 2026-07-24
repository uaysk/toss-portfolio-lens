import { z } from "zod";

export const PAIR_CATALOG_VERSION = "scalping-pair-catalog/v1" as const;

const PairSymbolSchema = z.string()
  .trim()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/));

export const PairDirectionSchema = z.enum(["bull", "bear", "cash"]);
export type PairDirection = z.infer<typeof PairDirectionSchema>;

export const PairSessionSchema = z.enum([
  "day_market",
  "pre_market",
  "regular",
  "after_market",
]);
export type PairSession = z.infer<typeof PairSessionSchema>;

export const PairExecutionLegSchema = z.object({
  executionSymbol: PairSymbolSchema,
  leverageMultiplier: z.number().finite(),
}).strict();
export type PairExecutionLeg = z.infer<typeof PairExecutionLegSchema>;

export const PairCatalogEntrySchema = z.object({
  catalogVersion: z.literal(PAIR_CATALOG_VERSION),
  pairId: z.string().trim().min(1).max(96).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  marketCountry: z.literal("US"),
  currency: z.literal("USD"),
  signalSymbol: PairSymbolSchema,
  bull: PairExecutionLegSchema,
  bear: PairExecutionLegSchema,
  allowedSessions: z.array(PairSessionSchema).min(1).max(4),
  maxSpreadBps: z.number().finite().positive().max(5_000),
}).strict().superRefine((entry, context) => {
  if (entry.bull.leverageMultiplier <= 0) {
    context.addIssue({
      code: "custom",
      path: ["bull", "leverageMultiplier"],
      message: "bull leverageMultiplier must be positive.",
    });
  }
  if (entry.bear.leverageMultiplier >= 0) {
    context.addIssue({
      code: "custom",
      path: ["bear", "leverageMultiplier"],
      message: "bear leverageMultiplier must be negative.",
    });
  }
  const symbols = [
    entry.signalSymbol,
    entry.bull.executionSymbol,
    entry.bear.executionSymbol,
  ];
  if (new Set(symbols).size !== symbols.length) {
    context.addIssue({
      code: "custom",
      path: ["signalSymbol"],
      message: "signal, bull, and bear symbols must be distinct.",
    });
  }
  if (new Set(entry.allowedSessions).size !== entry.allowedSessions.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedSessions"],
      message: "allowedSessions must not contain duplicates.",
    });
  }
});
export type PairCatalogEntry = z.infer<typeof PairCatalogEntrySchema>;

export type PairCatalog = ReadonlyMap<string, Readonly<PairCatalogEntry>>;

export type PairExecutionMapping =
  | {
      pairId: string;
      signalSymbol: string;
      direction: "cash";
      executionSymbol: null;
      leverageMultiplier: 0;
    }
  | {
      pairId: string;
      signalSymbol: string;
      direction: "bull" | "bear";
      executionSymbol: string;
      leverageMultiplier: number;
    };

export function validatePairCatalogEntry(input: unknown): PairCatalogEntry {
  return PairCatalogEntrySchema.parse(input);
}

export function createPairCatalog(entries: readonly unknown[]): PairCatalog {
  const parsed = entries.map(validatePairCatalogEntry);
  const pairIds = new Set<string>();
  for (const entry of parsed) {
    if (pairIds.has(entry.pairId)) {
      throw new Error(`Duplicate pair catalog id: ${entry.pairId}`);
    }
    pairIds.add(entry.pairId);
  }
  return new Map(
    [...parsed]
      .sort((left, right) => left.pairId.localeCompare(right.pairId))
      .map((entry) => [entry.pairId, Object.freeze({
        ...entry,
        bull: Object.freeze({ ...entry.bull }),
        bear: Object.freeze({ ...entry.bear }),
        // Zod's output type is mutable, while the catalog is deliberately
        // immutable at runtime. Keep the public parsed-entry type compatible
        // with callers and freeze the owned copy.
        allowedSessions: Object.freeze([...entry.allowedSessions]) as unknown as PairSession[],
      })] as const),
  );
}

const DEFAULT_PAIR_ENTRIES = [
  {
    catalogVersion: PAIR_CATALOG_VERSION,
    pairId: "qqq-tqqq-sqqq",
    marketCountry: "US",
    currency: "USD",
    signalSymbol: "QQQ",
    bull: { executionSymbol: "TQQQ", leverageMultiplier: 3 },
    bear: { executionSymbol: "SQQQ", leverageMultiplier: -3 },
    allowedSessions: ["regular"],
    maxSpreadBps: 35,
  },
  {
    catalogVersion: PAIR_CATALOG_VERSION,
    pairId: "smh-soxl-soxs",
    marketCountry: "US",
    currency: "USD",
    signalSymbol: "SMH",
    bull: { executionSymbol: "SOXL", leverageMultiplier: 3 },
    bear: { executionSymbol: "SOXS", leverageMultiplier: -3 },
    allowedSessions: ["regular"],
    maxSpreadBps: 35,
  },
  {
    catalogVersion: PAIR_CATALOG_VERSION,
    pairId: "soxx-soxl-soxs",
    marketCountry: "US",
    currency: "USD",
    signalSymbol: "SOXX",
    bull: { executionSymbol: "SOXL", leverageMultiplier: 3 },
    bear: { executionSymbol: "SOXS", leverageMultiplier: -3 },
    allowedSessions: ["regular"],
    maxSpreadBps: 35,
  },
  {
    catalogVersion: PAIR_CATALOG_VERSION,
    pairId: "tsla-tsll-tslq",
    marketCountry: "US",
    currency: "USD",
    signalSymbol: "TSLA",
    bull: { executionSymbol: "TSLL", leverageMultiplier: 2 },
    bear: { executionSymbol: "TSLQ", leverageMultiplier: -2 },
    allowedSessions: ["regular"],
    maxSpreadBps: 50,
  },
  {
    catalogVersion: PAIR_CATALOG_VERSION,
    pairId: "tsla-tsll-tsls",
    marketCountry: "US",
    currency: "USD",
    signalSymbol: "TSLA",
    bull: { executionSymbol: "TSLL", leverageMultiplier: 2 },
    bear: { executionSymbol: "TSLS", leverageMultiplier: -1 },
    allowedSessions: ["regular"],
    maxSpreadBps: 50,
  },
] as const;

export const DEFAULT_PAIR_CATALOG = createPairCatalog(DEFAULT_PAIR_ENTRIES);

export function getPairCatalogEntry(
  pairId: string,
  catalog: PairCatalog = DEFAULT_PAIR_CATALOG,
): Readonly<PairCatalogEntry> {
  const normalized = pairId.trim().toLowerCase();
  const entry = catalog.get(normalized);
  if (!entry) throw new Error(`Unknown pair catalog id: ${normalized || "<empty>"}`);
  return entry;
}

export function mapPairDirection(
  entryInput: PairCatalogEntry,
  directionInput: PairDirection,
): PairExecutionMapping {
  const entry = validatePairCatalogEntry(entryInput);
  const direction = PairDirectionSchema.parse(directionInput);
  if (direction === "cash") {
    return {
      pairId: entry.pairId,
      signalSymbol: entry.signalSymbol,
      direction,
      executionSymbol: null,
      leverageMultiplier: 0,
    };
  }
  const leg = entry[direction];
  return {
    pairId: entry.pairId,
    signalSymbol: entry.signalSymbol,
    direction,
    executionSymbol: leg.executionSymbol,
    leverageMultiplier: leg.leverageMultiplier,
  };
}
