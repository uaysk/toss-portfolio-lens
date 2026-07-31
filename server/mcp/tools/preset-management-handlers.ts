import {
  PresetRevisionConflictError,
  type PresetSource,
} from "../../repositories/preset-repository.js";
import type { OptimizationRepository } from "../../repositories/optimization-repository.js";
import type { RunRepository } from "../../repositories/run-repository.js";
import {
  PRESET_EXPORT_SCHEMA_VERSION,
  PresetValidationError,
  type PresetService,
} from "../../services/preset-service.js";
import { envelope, ServiceError } from "../../services/service-envelope.js";
import { mcpVisibleRun } from "../run-visibility.js";
import { MCP_TOOL_DOMAINS } from "./domain-registry.js";
import {
  object,
  recordValue,
  serviceNotFound,
  type GenericInput,
} from "./handler-support.js";

type PresetToolName = (typeof MCP_TOOL_DOMAINS.presets)[number];
type PresetToolHandler = (input: unknown, ownerSubject: string) => Promise<unknown>;

export type PresetManagementDependencies = {
  presets: PresetService;
  runRepository: RunRepository;
  optimizationRepository: OptimizationRepository;
};

export async function presetOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PresetRevisionConflictError) {
      throw new ServiceError({
        code: "PRESET_REVISION_CONFLICT",
        message: "preset이 다른 요청에서 변경되었습니다. 최신 revision을 다시 조회해 주세요.",
        retryable: false,
        details: {
          preset_id: error.presetId,
          expected_revision: error.expectedRevision,
          current_revision: error.currentRevision,
        },
      });
    }
    if (error instanceof PresetValidationError) {
      throw new ServiceError({
        code: "INVALID_PRESET",
        message: error.message,
        retryable: false,
        ...(error.field ? { field: error.field } : {}),
      });
    }
    throw error;
  }
}

async function resolvedPresetConfig(
  dependencies: PresetManagementDependencies,
  ownerSubject: string,
  value: GenericInput,
  fallback?: unknown,
): Promise<{ config: unknown; source: PresetSource }> {
  const source = (recordValue(value.source) ?? { type: "manual" }) as PresetSource;
  const explicit = recordValue(value.config);
  const symbols = Array.isArray(value.symbols)
    ? (value.symbols as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  if (explicit) {
    return {
      config: symbols ? { ...explicit, symbols } : explicit,
      source,
    };
  }
  if (source.type === "run") {
    const run = mcpVisibleRun(await dependencies.runRepository.get(String(source.runId), ownerSubject));
    if (!run) throw serviceNotFound("run", String(source.runId));
    const base = recordValue(run.input) ?? { input: run.input };
    return { config: symbols ? { ...base, symbols } : base, source };
  }
  if (source.type === "optimization_candidate" || source.type === "pareto_candidate") {
    const runId = String(source.runId);
    const run = mcpVisibleRun(await dependencies.runRepository.get(runId, ownerSubject));
    if (!run) throw serviceNotFound("run", runId);
    if (run.kind !== "optimization") {
      throw new ServiceError({
        code: "INVALID_RUN_KIND",
        message: "최적화 후보 preset에는 optimization run이 필요합니다.",
        retryable: false,
      });
    }
    const index = Math.max(0, Number(source.candidateIndex ?? 0));
    const candidate = await dependencies.optimizationRepository.getCandidateAt(
      runId,
      index,
      source.type === "pareto_candidate",
    );
    if (!candidate) {
      throw new ServiceError({
        code: "CANDIDATE_NOT_FOUND",
        message: "저장할 최적화 후보를 찾을 수 없습니다.",
        retryable: false,
      });
    }
    return {
      config: {
        symbols: Object.keys(candidate.weights),
        weights: candidate.weights,
        optimization_run_id: runId,
        candidate_id: candidate.id,
        candidate_rank: candidate.rank,
        metrics: candidate.metrics,
      },
      source,
    };
  }
  if (source.type === "current_portfolio") {
    const holdings = Array.isArray(source.holdings) ? source.holdings : [];
    const holdingRecords = holdings
      .map(recordValue)
      .filter((item): item is GenericInput => Boolean(item));
    const explicitWeights = Object.fromEntries(holdingRecords
      .filter((item) => typeof item.symbol === "string" && typeof item.weight === "number")
      .map((item) => [String(item.symbol), Number(item.weight)]));
    const currencies = new Set(holdingRecords
      .map((item) => item.currency)
      .filter((item): item is string => typeof item === "string"));
    const evaluationTotal = holdingRecords.reduce(
      (sum, item) => sum
        + (typeof item.evaluationAmount === "number" ? item.evaluationAmount : 0),
      0,
    );
    const sameCurrencyWeights = currencies.size <= 1 && evaluationTotal > 0
      ? Object.fromEntries(holdingRecords
        .filter((item) => (
          typeof item.symbol === "string"
          && typeof item.evaluationAmount === "number"
        ))
        .map((item) => [String(item.symbol), Number(item.evaluationAmount) / evaluationTotal]))
      : undefined;
    const defaultWeights = Object.keys(explicitWeights).length === holdingRecords.length
      ? explicitWeights
      : sameCurrencyWeights;
    return {
      config: {
        symbols: symbols ?? holdings
          .map((item) => recordValue(item)?.symbol)
          .filter((item): item is string => typeof item === "string"),
        holdings,
        ...(defaultWeights ? { defaultWeights } : {}),
        ...(typeof recordValue(source.summary)?.cashWeight === "number"
          ? { cashWeight: Number(recordValue(source.summary)?.cashWeight) }
          : {}),
        benchmark: recordValue(source.summary)?.benchmark,
        sourceAsOf: source.asOf,
        dataQuality: {
          defaultWeights: defaultWeights ? "available" : "unavailable",
          cashWeight: typeof recordValue(source.summary)?.cashWeight === "number"
            ? "available"
            : "unavailable",
          ...(!defaultWeights && currencies.size > 1
            ? { warning: "다중 통화 보유 평가액에 공통 기준통화 환산값이 없어 기본 비중을 추정하지 않았습니다." }
            : {}),
        },
      },
      source,
    };
  }
  if (fallback !== undefined) {
    const base = recordValue(fallback) ?? { value: fallback };
    return { config: symbols ? { ...base, symbols } : base, source };
  }
  return { config: { symbols: symbols ?? [] }, source };
}

function importDocument(value: unknown): {
  name: string;
  description: string;
  config: unknown;
  tags: string[];
  source: PresetSource;
} {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new ServiceError({
        code: "INVALID_PRESET_IMPORT",
        message: "preset 가져오기 JSON을 해석할 수 없습니다.",
        retryable: false,
      });
    }
  }
  const root = recordValue(parsed);
  const preset = recordValue(root?.preset);
  if (!root
    || root.schema_version !== PRESET_EXPORT_SCHEMA_VERSION
    || !preset
    || typeof preset.name !== "string") {
    throw new ServiceError({
      code: "INVALID_PRESET_IMPORT",
      message: "지원하지 않는 preset export 문서입니다.",
      retryable: false,
    });
  }
  return {
    name: preset.name,
    description: typeof preset.description === "string" ? preset.description : "",
    config: preset.config,
    tags: Array.isArray(preset.tags)
      ? preset.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    source: (recordValue(preset.source) ?? { type: "unknown" }) as PresetSource,
  };
}

export function createPresetManagementHandlers(
  dependencies: PresetManagementDependencies,
): Record<PresetToolName, PresetToolHandler> {
  return {
    list_portfolio_presets: async (input, ownerSubject) => {
      const value = object(input);
      const listed = await presetOperation(() => dependencies.presets.list({
        ownerSubject,
        ...(value.query ? { search: String(value.query) } : {}),
        tags: value.tags as string[],
        ...(value.cursor ? { cursor: String(value.cursor) } : {}),
        limit: Number(value.limit),
      }));
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: {
          items: listed.items,
          presets: listed.items,
          next_cursor: listed.nextCursor,
          nextCursor: listed.nextCursor,
        },
        dataQuality: { returned: listed.items.length, persistent: true },
      });
    },
    get_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const preset = await presetOperation(
        () => dependencies.presets.get(presetId, ownerSubject),
      );
      if (!preset) throw serviceNotFound("preset", presetId);
      const history = value.includeHistory
        ? await presetOperation(() => dependencies.presets.history(presetId, ownerSubject))
        : undefined;
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset, history },
        dataQuality: { persistent: true, revision: preset.revision },
      });
    },
    create_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const resolved = await resolvedPresetConfig(dependencies, ownerSubject, value);
      const preset = await presetOperation(() => dependencies.presets.create({
        ownerSubject,
        name: String(value.name),
        description: String(value.description ?? ""),
        config: resolved.config,
        tags: value.tags as string[],
        source: resolved.source,
      }));
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset },
        dataQuality: { persistent: true, revision: preset.revision },
      });
    },
    update_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const current = await presetOperation(
        () => dependencies.presets.get(presetId, ownerSubject),
      );
      if (!current) throw serviceNotFound("preset", presetId);
      const needsConfig = value.config !== undefined
        || value.symbols !== undefined
        || value.source !== undefined;
      const resolved = needsConfig
        ? await resolvedPresetConfig(dependencies, ownerSubject, value, current.config)
        : undefined;
      const preset = await presetOperation(() => dependencies.presets.update({
        id: presetId,
        ownerSubject,
        expectedRevision: Number(value.revision),
        ...(value.name !== undefined ? { name: String(value.name) } : {}),
        ...(value.description !== undefined
          ? { description: String(value.description) }
          : {}),
        ...(resolved ? { config: resolved.config } : {}),
        ...(value.tags !== undefined ? { tags: value.tags as string[] } : {}),
        ...(value.source !== undefined && resolved ? { source: resolved.source } : {}),
      }));
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset },
        dataQuality: { persistent: true, revision: preset.revision },
      });
    },
    duplicate_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const source = await dependencies.presets.get(presetId, ownerSubject);
      if (!source) throw serviceNotFound("preset", presetId);
      const preset = await presetOperation(() => dependencies.presets.duplicate({
        id: presetId,
        ownerSubject,
        name: (value.name ? String(value.name) : `${source.name} 복사본`).slice(0, 200),
      }));
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset, duplicated_from: presetId },
        dataQuality: { persistent: true },
      });
    },
    delete_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const deleted = await presetOperation(
        () => dependencies.presets.delete({ id: presetId, ownerSubject }),
      );
      if (!deleted) throw serviceNotFound("preset", presetId);
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset_id: presetId, deleted: true },
        dataQuality: { soft_delete: true },
      });
    },
    import_portfolio_presets: async (input, ownerSubject) => {
      const value = object(input);
      const mode = String(value.conflictMode ?? "rename");
      const imported = importDocument(value.document);
      const matches = await presetOperation(() => dependencies.presets.list({
        ownerSubject,
        search: imported.name,
        limit: 100,
      }));
      const existing = matches.items.find((preset) => preset.name === imported.name);
      let preset;
      if (existing && mode === "skip") {
        preset = existing;
      } else if (existing && mode === "replace") {
        preset = await presetOperation(() => dependencies.presets.update({
          id: existing.id,
          ownerSubject,
          expectedRevision: existing.revision,
          description: imported.description,
          config: imported.config,
          tags: imported.tags,
          source: { type: "import", originalSource: imported.source },
        }));
      } else {
        let renamed: string | undefined;
        if (existing) {
          const used = new Set(matches.items.map((item) => item.name));
          renamed = `${imported.name} 가져오기`;
          let suffix = 2;
          while (used.has(renamed)) renamed = `${imported.name} 가져오기 ${suffix++}`;
        }
        preset = await presetOperation(() => dependencies.presets.importPreset({
          ownerSubject,
          payload: value.document,
          ...(renamed ? { name: renamed } : {}),
        }));
      }
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: {
          preset,
          conflict_mode: mode,
          skipped: Boolean(existing && mode === "skip"),
        },
        dataQuality: { persistent: true, revision: preset.revision },
      });
    },
    export_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const document = await presetOperation(
        () => dependencies.presets.exportPreset(presetId, ownerSubject),
      );
      if (!document) throw serviceNotFound("preset", presetId);
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset_id: presetId, document },
        dataQuality: { portable_schema: PRESET_EXPORT_SCHEMA_VERSION },
      });
    },
  };
}
