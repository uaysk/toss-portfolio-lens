import { createHash } from "node:crypto";
import {
  evaluatePairEnsemble,
  type PairEnsembleDecision,
  type PairEnsembleInput,
} from "./ensemble-policy.js";
import { PAIR_CATALOG_VERSION } from "./pair-catalog.js";
import { PAIR_MODEL_NORMALIZATION_VERSION } from "./model-output-normalization.js";

export const PAIR_DECISION_PROVENANCE_VERSION = "pair-decision-provenance/v2" as const;

export type PairDecisionProvenance = {
  schemaVersion: typeof PAIR_DECISION_PROVENANCE_VERSION;
  decisionId: string;
  pairId: string;
  signalSymbol: string;
  executionSymbol: string | null;
  direction: PairEnsembleDecision["direction"];
  origin?: string;
  decisionAt: string;
  eligibleAfter: string;
  catalogVersion: typeof PAIR_CATALOG_VERSION;
  policyVersion: PairEnsembleDecision["policyVersion"];
  profileId: string;
  normalizationVersion: typeof PAIR_MODEL_NORMALIZATION_VERSION;
  degraded: boolean;
  components: Record<string, number>;
  componentDetails: PairEnsembleDecision["componentScores"];
  weights: PairEnsembleDecision["weights"];
  finalScores: PairEnsembleDecision["finalScores"];
  reasons: string[];
  provenance: string[];
  rawInputs: {
    kronos: unknown;
    rust: unknown;
    market: unknown;
  };
  decision: PairEnsembleDecision;
  replayInput: PairEnsembleInput;
  sizing?: unknown;
  integrity: {
    algorithm: "sha256";
    inputDigest: string;
    decisionDigest: string;
    sizingDigest?: string;
  };
};

export type PairDecisionReplayVerification = {
  valid: boolean;
  reasonCodes: string[];
  replayedDecision?: PairEnsembleDecision;
};

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, path = "$"): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite provenance value at ${path}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const normalized = canonicalValue(item, `${path}[${index}]`);
      return normalized === undefined ? null : normalized;
    });
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) {
      const normalized = canonicalValue(source[key], `${path}.${key}`);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  throw new Error(`Unsupported provenance value at ${path}.`);
}

export function canonicalPairDecisionJson(value: unknown): string {
  const normalized = canonicalValue(value);
  if (normalized === undefined) throw new Error("Top-level provenance value cannot be undefined.");
  return JSON.stringify(normalized);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalPairDecisionJson(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function decisionComparable(value: PairEnsembleDecision) {
  return {
    ...value,
    reasonCodes: [...value.reasonCodes],
    weights: { ...value.weights },
    componentScores: {
      kronos: { ...value.componentScores.kronos },
      rust: { ...value.componentScores.rust },
    },
    finalScores: { ...value.finalScores },
    costs: { ...value.costs },
  };
}

function modelLabel(input: PairEnsembleInput, component: "kronos"): string {
  const model = input.models[component].provenance;
  return `${model.modelId ?? component}@${model.modelRevision ?? "unavailable"}`
    + `:${input.models[component].status}`;
}

function flatComponents(decision: PairEnsembleDecision): Record<string, number> {
  return {
    kronosBull: decision.componentScores.kronos.bull,
    kronosBear: decision.componentScores.kronos.bear,
    rustBull: decision.componentScores.rust.bull,
    rustBear: decision.componentScores.rust.bear,
  };
}

export function createPairDecisionProvenance(input: {
  ensembleInput: PairEnsembleInput;
  decision: PairEnsembleDecision;
  sizing?: unknown;
}): PairDecisionProvenance {
  const replayed = evaluatePairEnsemble(input.ensembleInput);
  if (canonicalPairDecisionJson(decisionComparable(replayed))
    !== canonicalPairDecisionJson(decisionComparable(input.decision))) {
    throw new Error("Decision does not reproduce from the supplied ensemble input.");
  }
  const replayInput = clone(input.ensembleInput);
  const decision = clone(input.decision);
  const inputDigest = digest(replayInput);
  const decisionDigest = digest(decisionComparable(decision));
  const decisionId = `pair-decision:${decisionDigest}`;
  const sizing = input.sizing === undefined ? undefined : clone(input.sizing);
  return {
    schemaVersion: PAIR_DECISION_PROVENANCE_VERSION,
    decisionId,
    pairId: decision.pairId,
    signalSymbol: decision.signalSymbol,
    executionSymbol: decision.executionSymbol,
    direction: decision.direction,
    ...(decision.origin ? { origin: decision.origin } : {}),
    decisionAt: decision.decisionAt,
    eligibleAfter: decision.eligibleAfter,
    catalogVersion: PAIR_CATALOG_VERSION,
    policyVersion: decision.policyVersion,
    profileId: decision.profileId,
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    degraded: decision.degraded,
    components: flatComponents(decision),
    componentDetails: clone(decision.componentScores),
    weights: { ...decision.weights },
    finalScores: { ...decision.finalScores },
    reasons: [...decision.reasonCodes],
    provenance: [
      modelLabel(replayInput, "kronos"),
      `rust:${replayInput.rust.status ?? "unavailable"}`,
    ],
    rawInputs: {
      kronos: clone(replayInput.models.kronos.rawOutput),
      rust: clone(replayInput.rust.rawOutput ?? replayInput.rust),
      market: clone(replayInput.market),
    },
    decision,
    replayInput,
    ...(sizing !== undefined ? { sizing } : {}),
    integrity: {
      algorithm: "sha256",
      inputDigest,
      decisionDigest,
      ...(sizing !== undefined ? { sizingDigest: digest(sizing) } : {}),
    },
  };
}

export function verifyPairDecisionReplay(
  provenance: PairDecisionProvenance,
): PairDecisionReplayVerification {
  const reasonCodes: string[] = [];
  if (provenance.schemaVersion !== PAIR_DECISION_PROVENANCE_VERSION) {
    reasonCodes.push("provenance_schema_version_mismatch");
  }
  if (provenance.integrity.algorithm !== "sha256") {
    reasonCodes.push("unsupported_integrity_algorithm");
  }
  let replayedDecision: PairEnsembleDecision | undefined;
  try {
    const inputDigest = digest(provenance.replayInput);
    if (inputDigest !== provenance.integrity.inputDigest) {
      reasonCodes.push("input_digest_mismatch");
    }
    const storedDecisionDigest = digest(decisionComparable(provenance.decision));
    if (storedDecisionDigest !== provenance.integrity.decisionDigest) {
      reasonCodes.push("decision_digest_mismatch");
    }
    if (`pair-decision:${storedDecisionDigest}` !== provenance.decisionId) {
      reasonCodes.push("decision_id_mismatch");
    }
    if (provenance.sizing !== undefined
      && digest(provenance.sizing) !== provenance.integrity.sizingDigest) {
      reasonCodes.push("sizing_digest_mismatch");
    }
    replayedDecision = evaluatePairEnsemble(provenance.replayInput);
    if (canonicalPairDecisionJson(decisionComparable(replayedDecision))
      !== canonicalPairDecisionJson(decisionComparable(provenance.decision))) {
      reasonCodes.push("policy_replay_mismatch");
    }
  } catch {
    reasonCodes.push("replay_input_invalid");
  }
  return {
    valid: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)],
    ...(replayedDecision ? { replayedDecision } : {}),
  };
}
