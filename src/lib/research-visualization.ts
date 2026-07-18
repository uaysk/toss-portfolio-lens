export type CandidateMetricKey =
  | "return"
  | "volatility"
  | "maxDrawdown"
  | "sharpe"
  | "cvar"
  | "informationRatio"
  | "turnover"
  | "transactionCost"
  | "robustScore";

export type ResearchCandidate = {
  id: string;
  label: string;
  weights: Record<string, number>;
  screeningRank?: number;
  ledgerRank?: number;
  rankChange?: number;
  validationStatus: string;
  screeningMetrics: Record<string, unknown>;
  ledgerMetrics: Record<string, unknown>;
  metricDelta: Record<string, unknown>;
  robustDetail: Record<string, unknown>;
  ledgerDataQuality?: Record<string, unknown>;
  pareto: boolean;
  raw: Record<string, unknown>;
};

export type QuantileSeries = {
  keys: Array<{ key: string; quantile: number }>;
  points: Array<Record<string, string | number>>;
};

export function researchRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function researchArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedWeights(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(researchRecord(value))
    .flatMap(([symbol, raw]) => {
      const weight = finiteNumber(raw);
      return weight === undefined ? [] : [[symbol, weight] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function candidateSignature(value: unknown): string {
  const weights = normalizedWeights(researchRecord(value).weights ?? value);
  return Object.entries(weights).map(([symbol, weight]) => `${symbol}:${weight.toFixed(10)}`).join("|");
}

const metricAliases: Record<CandidateMetricKey, string[]> = {
  return: ["return", "cagr", "annualizedReturn"],
  volatility: ["volatility", "annualizedVolatility"],
  maxDrawdown: ["maxDrawdown", "drawdown"],
  sharpe: ["sharpe", "sharpeRatio"],
  cvar: ["cvar", "conditionalValueAtRisk"],
  informationRatio: ["informationRatio"],
  turnover: ["turnover"],
  transactionCost: ["transactionCost", "transactionCosts"],
  robustScore: ["robustScore", "score"],
};

export function candidateMetric(metrics: unknown, key: CandidateMetricKey): number | undefined {
  const source = researchRecord(metrics);
  for (const alias of metricAliases[key]) {
    const value = finiteNumber(source[alias]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function candidateLabel(weights: Record<string, number>, fallbackIndex: number): string {
  const leading = Object.entries(weights)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([symbol, weight]) => `${symbol} ${Math.round(weight * 100)}%`)
    .join(" · ");
  return leading || `후보 ${fallbackIndex + 1}`;
}

function mergeRaw(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return {
    ...left,
    ...right,
    weights: Object.keys(researchRecord(right.weights)).length ? right.weights : left.weights,
    screeningMetrics: Object.keys(researchRecord(right.screeningMetrics)).length
      ? right.screeningMetrics
      : left.screeningMetrics,
    ledgerMetrics: Object.keys(researchRecord(right.ledgerMetrics)).length
      ? right.ledgerMetrics
      : left.ledgerMetrics,
  };
}

/** Merge screening, ledger and Pareto artifacts by their deterministic weight signature. */
export function normalizeOptimizationCandidates(input: {
  candidates?: unknown;
  ledgerCandidates?: unknown;
  paretoCandidates?: unknown;
}): ResearchCandidate[] {
  const paretoSignatures = new Set(researchArray(input.paretoCandidates).map(candidateSignature).filter(Boolean));
  const merged = new Map<string, Record<string, unknown>>();
  const orderedSignatures: string[] = [];
  for (const source of [input.candidates, input.ledgerCandidates, input.paretoCandidates]) {
    for (const value of researchArray(source)) {
      const raw = researchRecord(value);
      const signature = candidateSignature(raw);
      if (!signature) continue;
      if (!merged.has(signature)) orderedSignatures.push(signature);
      merged.set(signature, mergeRaw(merged.get(signature) ?? {}, raw));
    }
  }
  return orderedSignatures.map((signature, index) => {
    const raw = merged.get(signature) ?? {};
    const weights = normalizedWeights(raw.weights);
    const screeningMetrics = researchRecord(raw.screeningMetrics ?? raw.metrics);
    const ledgerMetrics = researchRecord(raw.ledgerMetrics);
    const robustDetail = researchRecord(raw.ledgerRobustScoreDetail ?? raw.robustScoreDetail);
    return {
      id: signature,
      label: candidateLabel(weights, index),
      weights,
      ...(finiteNumber(raw.screeningRank) !== undefined ? { screeningRank: finiteNumber(raw.screeningRank) } : {}),
      ...(finiteNumber(raw.ledgerRank) !== undefined ? { ledgerRank: finiteNumber(raw.ledgerRank) } : {}),
      ...(finiteNumber(raw.rankChange) !== undefined ? { rankChange: finiteNumber(raw.rankChange) } : {}),
      validationStatus: typeof raw.validationStatus === "string" ? raw.validationStatus : "not_requested",
      screeningMetrics,
      ledgerMetrics,
      metricDelta: researchRecord(raw.metricDelta),
      robustDetail,
      ...(Object.keys(researchRecord(raw.ledgerDataQuality)).length
        ? { ledgerDataQuality: researchRecord(raw.ledgerDataQuality) }
        : {}),
      pareto: paretoSignatures.has(signature),
      raw,
    };
  });
}

/** Bound chart work while keeping every Pareto point and a deterministic sample of the rest. */
export function chartCandidates(candidates: ResearchCandidate[], limit = 2_000): ResearchCandidate[] {
  if (candidates.length <= limit) return candidates;
  const frontier = candidates.filter((candidate) => candidate.pareto);
  const room = Math.max(0, limit - frontier.length);
  if (!room) return frontier.slice(0, limit);
  const others = candidates.filter((candidate) => !candidate.pareto);
  const stride = Math.max(1, Math.ceil(others.length / room));
  return [...frontier, ...others.filter((_, index) => index % stride === 0).slice(0, room)];
}

export function candidateQualityStatus(candidate: ResearchCandidate): "available" | "partial" | "unavailable" {
  if (!candidate.ledgerDataQuality) return "unavailable";
  const warnings = researchArray(candidate.ledgerDataQuality.warnings);
  const pointInTime = candidate.ledgerDataQuality.pointInTimeUniverseStatus;
  return warnings.length || pointInTime === "unavailable" ? "partial" : "available";
}

export function downsampleRows<T>(rows: T[], limit = 500): T[] {
  if (rows.length <= limit) return rows;
  const stride = Math.ceil((rows.length - 1) / (limit - 1));
  const sampled = rows.filter((_, index) => index % stride === 0).slice(0, limit - 1);
  const last = rows.at(-1);
  return last === undefined ? sampled : [...sampled, last];
}

/** Convert worker percentile paths into one Recharts row per step/date. */
export function buildQuantileSeries(value: unknown, limit = 500): QuantileSeries {
  const paths = researchArray(value).map(researchRecord);
  const keys: QuantileSeries["keys"] = [];
  const rows = new Map<string, Record<string, string | number>>();
  for (const [index, path] of paths.entries()) {
    const quantile = finiteNumber(path.quantile) ?? index / Math.max(1, paths.length - 1);
    const key = `q${Math.round(quantile * 10_000)}`;
    keys.push({ key, quantile });
    for (const [pointIndex, pointValue] of researchArray(path.points).map(researchRecord).entries()) {
      const step = finiteNumber(pointValue.step) ?? pointIndex;
      const date = typeof pointValue.date === "string" ? pointValue.date : String(step);
      const rowKey = `${step}:${date}`;
      const row = rows.get(rowKey) ?? { step, date };
      const balance = finiteNumber(pointValue.balance ?? pointValue.value ?? pointValue.equity);
      if (balance !== undefined) row[key] = balance;
      rows.set(rowKey, row);
    }
  }
  const points = Array.from(rows.values()).sort((left, right) => Number(left.step) - Number(right.step));
  return { keys, points: downsampleRows(points, limit) };
}

export function buildOosEquitySeries(value: unknown, limit = 500): Array<{ fold: number; date: string; equity: number }> {
  const rows = researchArray(value).flatMap((item, index) => {
    const row = researchRecord(item);
    const equity = finiteNumber(row.equity ?? row.balance ?? row.value);
    if (equity === undefined) return [];
    return [{
      fold: finiteNumber(row.fold ?? row.step) ?? index,
      date: typeof row.date === "string" ? row.date : `fold-${index + 1}`,
      equity,
    }];
  });
  return downsampleRows(rows, limit);
}

export function parseFactorDraft(value: string): Record<string, number> {
  return Object.fromEntries(value.split(",").flatMap((entry) => {
    const [name, raw] = entry.split("=").map((part) => part.trim());
    const number = finiteNumber(raw);
    return name && number !== undefined ? [[name, number] as const] : [];
  }));
}
