import type { ArtifactDescriptor } from "../repositories/artifact-repository.js";
import type { PortfolioRunRecord } from "../repositories/run-repository.js";
import { HISTORICAL_LIMITATION } from "./service-envelope.js";

export const RESEARCH_REPORT_SCHEMA_VERSION = "portfolio-lens-research-report/v1";

export type ResearchReportArtifact = {
  descriptor: ArtifactDescriptor;
  content: unknown;
};

export type ResearchReportDocument = {
  schema_version: typeof RESEARCH_REPORT_SCHEMA_VERSION;
  generated_at: string;
  title: string;
  run: {
    id: string;
    kind: string;
    status: string;
    name?: string;
    data_revision: string;
    engine_version: string;
    request_hash: string;
    created_at: number;
    finished_at?: number;
  };
  executive_summary: unknown;
  methodology: {
    input: unknown;
    artifact_types: string[];
  };
  evidence: Array<{
    type: string;
    uri: string;
    checksum: string;
    rows: number;
    bytes: number;
    summary: unknown;
  }>;
  data_quality: {
    status: "complete" | "partial" | "unavailable";
    warnings: string[];
    missing_expected_artifacts: string[];
  };
  limitations: string[];
};

const EXPECTED_BY_KIND: Partial<Record<string, string[]>> = {
  backtest: ["equity", "drawdown", "holdings", "trades", "cash-ledger"],
  optimization: ["candidates", "worker-pareto-frontier"],
  walk_forward: ["walk-forward"],
  stress_test: ["scenario-comparison"],
  monte_carlo: ["monte-carlo-distribution", "monte-carlo-percentile-paths"],
  outlook: [
    "outlook-summary", "outlook-oos-equity", "outlook-quantile-paths", "outlook-calibration",
    "outlook-worst-scenarios", "outlook-sensitivity", "outlook-market-regimes",
  ],
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      row_count: value.length,
      ...(value.length ? { first_row: value[0], last_row: value.at(-1) } : {}),
    };
  }
  const source = record(value);
  if (!source) return value;
  const selectedKeys = [
    "summary", "metrics", "confidence", "probabilities", "oos", "calibration",
    "data_quality", "dataQuality", "warnings", "limitation", "distributions",
    "worst_scenario", "worstScenario", "scenario_count", "candidate_count",
  ];
  const selected = Object.fromEntries(
    selectedKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  if (Object.keys(selected).length) return selected;
  return { fields: Object.keys(source).sort().slice(0, 50) };
}

function containsUnavailableQuality(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof value === "string") {
    return ["unavailable", "missing", "not_supported", "unknown", "estimated"].includes(value.toLowerCase());
  }
  if (Array.isArray(value)) {
    const sample = value.length > 40 ? [...value.slice(0, 20), ...value.slice(-20)] : value;
    return sample.some((item) => containsUnavailableQuality(item, depth + 1));
  }
  const source = record(value);
  if (!source) return false;
  return Object.entries(source).some(([key, item]) => (
    /quality|availability|coverage|status|warning/i.test(key)
      ? containsUnavailableQuality(item, depth + 1)
      : depth < 2 && containsUnavailableQuality(item, depth + 1)
  ));
}

function code(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/```/g, "` ` `");
}

export function renderResearchReportMarkdown(document: ResearchReportDocument): string {
  const evidenceRows = document.evidence.length
    ? document.evidence.map((item) => (
      `| ${item.type} | ${item.rows.toLocaleString("en-US")} | ${item.bytes.toLocaleString("en-US")} | \`${item.checksum.slice(0, 12)}\` |`
    )).join("\n")
    : "| 없음 | 0 | 0 | - |";
  const warningRows = document.data_quality.warnings.length
    ? document.data_quality.warnings.map((warning) => `- ${warning}`).join("\n")
    : "- 명시적으로 보고된 경고 없음";
  const missingRows = document.data_quality.missing_expected_artifacts.length
    ? document.data_quality.missing_expected_artifacts.map((item) => `- ${item}`).join("\n")
    : "- 없음";
  return `# ${document.title}

생성 시각: ${document.generated_at}

Run: \`${document.run.id}\` (${document.run.kind}, ${document.run.status})

데이터 revision: \`${document.run.data_revision}\`

엔진: \`${document.run.engine_version}\`

## 요약

\`\`\`json
${code(document.executive_summary)}
\`\`\`

## 재현 입력

\`\`\`json
${code(document.methodology.input)}
\`\`\`

## 증거 artifact

| 유형 | 행 | 바이트 | SHA-256 |
| --- | ---: | ---: | --- |
${evidenceRows}

## 데이터 품질

상태: **${document.data_quality.status}**

${warningRows}

누락된 기대 artifact:

${missingRows}

## 한계

${document.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

export class ResearchReportService {
  build(input: {
    run: PortfolioRunRecord;
    artifacts: ResearchReportArtifact[];
    title?: string;
    generatedAt?: string;
  }): ResearchReportDocument {
    const artifactTypes = new Set(input.artifacts.map((item) => item.descriptor.type));
    const missing = (EXPECTED_BY_KIND[input.run.kind] ?? []).filter((type) => !artifactTypes.has(type as never));
    const artifactQualityWarnings = input.artifacts
      .filter((artifact) => containsUnavailableQuality(artifact.content))
      .map((artifact) => `${artifact.descriptor.type} artifact에 unavailable/missing/estimated 데이터 품질 상태가 있습니다.`);
    const warnings = Array.from(new Set([...input.run.warnings.filter(Boolean), ...artifactQualityWarnings]));
    const status = input.artifacts.length === 0
      ? "unavailable" as const
      : missing.length || warnings.length ? "partial" as const : "complete" as const;
    return {
      schema_version: RESEARCH_REPORT_SCHEMA_VERSION,
      generated_at: input.generatedAt ?? new Date().toISOString(),
      title: input.title?.trim() || input.run.name || `${input.run.kind} 연구 보고서`,
      run: {
        id: input.run.id,
        kind: input.run.kind,
        status: input.run.status,
        ...(input.run.name ? { name: input.run.name } : {}),
        data_revision: input.run.dataRevision,
        engine_version: input.run.engineVersion,
        request_hash: input.run.requestHash,
        created_at: input.run.createdAt,
        ...(input.run.finishedAt !== undefined ? { finished_at: input.run.finishedAt } : {}),
      },
      executive_summary: input.run.summary ?? { status: input.run.status },
      methodology: {
        input: input.run.input,
        artifact_types: [...artifactTypes].sort(),
      },
      evidence: input.artifacts.map((item) => ({
        type: item.descriptor.type,
        uri: item.descriptor.uri,
        checksum: item.descriptor.checksum,
        rows: item.descriptor.rowCount,
        bytes: item.descriptor.byteCount,
        summary: compactEvidence(item.content),
      })),
      data_quality: {
        status,
        warnings,
        missing_expected_artifacts: missing,
      },
      limitations: Array.from(new Set([
        HISTORICAL_LIMITATION,
        "보고서는 저장된 run과 artifact만 조합하며, 누락된 공급자 데이터를 추정해 채우지 않습니다.",
        ...(missing.length ? [`기대 artifact가 누락되었습니다: ${missing.join(", ")}`] : []),
        ...(!artifactTypes.has("outlook-calibration") && ["outlook", "monte_carlo"].includes(input.run.kind)
          ? ["과거 예측구간 calibration artifact가 없어 확률 예측의 보정 품질을 독립 검증할 수 없습니다."]
          : []),
      ])),
    };
  }

  render(document: ResearchReportDocument, format: "json" | "markdown"): unknown {
    return format === "json" ? document : renderResearchReportMarkdown(document);
  }
}
