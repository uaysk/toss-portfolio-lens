import { randomUUID } from "node:crypto";
import { buildInfo } from "../../build-info.js";
import type { OptimizationRepository } from "../../repositories/optimization-repository.js";
import type {
  PortfolioRunKind,
  PortfolioRunRecord,
  RunRepository,
} from "../../repositories/run-repository.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { RunService } from "../../services/run-service.js";
import {
  envelope,
  requestHash,
  ServiceError,
} from "../../services/service-envelope.js";
import {
  MCP_VISIBLE_RUN_KINDS,
  mcpVisibleRun,
} from "../run-visibility.js";
import {
  resolvedPresetExecutionSchemas,
  toolSchemas,
  type ToolName,
} from "../schemas.js";
import { MCP_TOOL_DOMAINS } from "./domain-registry.js";
import {
  object,
  recordValue,
  runResultEnvelope,
  serviceNotFound,
  type GenericInput,
} from "./handler-support.js";

type RunToolName = (typeof MCP_TOOL_DOMAINS.runs)[number];
type RunToolHandler = (input: unknown, ownerSubject: string) => Promise<unknown>;
type ToolInvoker = (
  name: ToolName,
  input: unknown,
  ownerSubject: string,
) => Promise<unknown>;

export type RunManagementDependencies = {
  runs: RunService;
  artifacts: ArtifactService;
  runRepository: RunRepository;
  optimizationRepository: OptimizationRepository;
};

const REPLAY_TOOL_BY_KIND: Partial<Record<PortfolioRunKind, ToolName>> = {
  backtest: "run_portfolio_backtest",
  optimization: "optimize_portfolio",
  walk_forward: "walk_forward_optimize",
  stress_test: "stress_test_portfolio",
  weight_sensitivity: "analyze_weight_sensitivity",
  start_date_sensitivity: "analyze_start_date_sensitivity",
  rebalance_sensitivity: "analyze_rebalance_sensitivity",
  cash_flow_sensitivity: "analyze_cash_flow_sensitivity",
  monte_carlo: "simulate_portfolio_monte_carlo",
  outlook: "analyze_portfolio_outlook",
  exposure_analysis: "analyze_portfolio_exposures",
  pareto_frontier: "build_pareto_frontier",
  research_report: "generate_research_report",
  technical_analysis: "analyze_technical_signals",
  technical_strategy: "run_technical_strategy_backtest",
};

function runListArchived(value: unknown): boolean | "all" {
  if (value === "all") return "all";
  return value === "archived";
}

function eventCursor(value: unknown): { after: number; afterId?: string } | undefined {
  if (value === undefined) return undefined;
  const raw = String(value);
  if (/^\d{1,16}$/u.test(raw)) return { after: Number(raw) };
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { after?: unknown; id?: unknown };
    if (!Number.isSafeInteger(parsed.after) || Number(parsed.after) < 0) {
      throw new Error("invalid timestamp");
    }
    if (parsed.id === undefined) return { after: Number(parsed.after) };
    if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 64) {
      throw new Error("invalid event id");
    }
    return { after: Number(parsed.after), afterId: parsed.id };
  } catch {
    throw new ServiceError({
      code: "INVALID_EVENT_CURSOR",
      message: "run event cursor가 올바르지 않습니다.",
      retryable: false,
      field: "cursor",
    });
  }
}

function runManifest(
  run: PortfolioRunRecord,
  artifacts: Awaited<ReturnType<ArtifactService["list"]>>,
) {
  return {
    schema_version: "portfolio-lens-run-manifest/v1",
    captured_at: new Date(run.createdAt).toISOString(),
    finalized: false,
    run: {
      id: run.id,
      kind: run.kind,
      request_hash: run.requestHash,
      data_revision: run.dataRevision,
      engine_version: run.engineVersion,
      status: run.status,
      input: run.input,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      replay_of: run.replayOf,
    },
    build: buildInfo(),
    reproducibility: {
      deterministic_when: "동일 seed, 정규화 입력, data revision, 엔진·worker schema 버전이 동일할 때",
      seed: recordValue(run.input)?.seed ?? null,
      artifact_checksums: artifacts.map((artifact) => ({
        type: artifact.type,
        checksum: artifact.checksum,
        rows: artifact.rowCount,
        bytes: artifact.byteCount,
        schema_version: artifact.schemaVersion,
      })),
    },
  };
}

function finalizedRunManifest(
  base: unknown,
  run: PortfolioRunRecord,
  artifacts: Awaited<ReturnType<ArtifactService["list"]>>,
) {
  const stored = recordValue(base) ?? {};
  const storedRun = recordValue(stored.run) ?? {};
  const reproducibility = recordValue(stored.reproducibility) ?? {};
  const coreArtifacts = artifacts.filter((artifact) => artifact.type !== "research-report");
  return {
    ...stored,
    schema_version: "portfolio-lens-run-manifest/v1",
    finalized: true,
    finalized_at: new Date(run.finishedAt ?? run.updatedAt).toISOString(),
    run: {
      ...storedRun,
      id: run.id,
      kind: run.kind,
      request_hash: run.requestHash,
      data_revision: run.dataRevision,
      engine_version: run.engineVersion,
      status: run.status,
      input: run.input,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      replay_of: run.replayOf,
    },
    reproducibility: {
      ...reproducibility,
      artifact_checksums: coreArtifacts.map((artifact) => ({
        type: artifact.type,
        checksum: artifact.checksum,
        rows: artifact.rowCount,
        bytes: artifact.byteCount,
        schema_version: artifact.schemaVersion,
      })),
    },
  };
}

function nestedRunId(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const source = recordValue(value);
  if (!source) return undefined;
  const direct = source.run_id ?? source.runId;
  if (typeof direct === "string") return direct;
  return nestedRunId(source.result, depth + 1) ?? nestedRunId(source.run, depth + 1);
}

export function createRunManagementHandlers(
  dependencies: RunManagementDependencies,
  invokeTool: ToolInvoker,
): Record<RunToolName, RunToolHandler> {
  return {
    get_run_status: async (input, ownerSubject) => {
      const value = object(input);
      const run = mcpVisibleRun(
        await dependencies.runs.get(String(value.runId), ownerSubject),
      );
      if (!run) {
        throw new ServiceError({
          code: "RUN_NOT_FOUND",
          message: "run을 찾을 수 없습니다.",
          retryable: false,
        });
      }
      return runResultEnvelope(run, value, [], false);
    },
    cancel_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const before = mcpVisibleRun(await dependencies.runs.get(runId, ownerSubject));
      if (!before) {
        throw new ServiceError({
          code: "RUN_NOT_FOUND",
          message: "run을 찾을 수 없습니다.",
          retryable: false,
        });
      }
      const cancelled = await dependencies.runs.cancel(runId, ownerSubject);
      const run = mcpVisibleRun(await dependencies.runs.get(runId, ownerSubject));
      if (!run) {
        throw new ServiceError({
          code: "RUN_NOT_FOUND",
          message: "run을 찾을 수 없습니다.",
          retryable: false,
        });
      }
      const result = runResultEnvelope(
        run,
        value,
        [],
        false,
      ) as { result: GenericInput };
      result.result.cancel_requested = cancelled;
      return result;
    },
    get_run_result: async (input, ownerSubject) => {
      const value = object(input);
      const run = mcpVisibleRun(
        await dependencies.runs.get(String(value.runId), ownerSubject),
      );
      if (!run) {
        throw new ServiceError({
          code: "RUN_NOT_FOUND",
          message: "run을 찾을 수 없습니다.",
          retryable: false,
        });
      }
      const artifactIndex = await dependencies.artifacts.list(run.id);
      const shouldExternalize = dependencies.artifacts.shouldExternalize(run.result);
      const response = runResultEnvelope(
        run,
        value,
        artifactIndex,
        !shouldExternalize,
      ) as { result: GenericInput; warnings: string[] };
      if (shouldExternalize) {
        response.result.result_externalized = true;
        response.warnings.push(
          "대용량 실행 결과는 artifact index의 resource URI로 조회해야 합니다.",
        );
      }
      return response;
    },
    list_runs: async (input, ownerSubject) => {
      const value = object(input);
      const listed = await dependencies.runRepository.list({
        ownerSubject,
        ...(value.query ? { search: String(value.query) } : {}),
        kinds: (value.kinds as PortfolioRunKind[]).length
          ? value.kinds as PortfolioRunKind[]
          : [...MCP_VISIBLE_RUN_KINDS],
        statuses: value.statuses as never,
        tags: value.tags as string[],
        archived: runListArchived(value.archived),
        ...(value.cursor ? { cursor: String(value.cursor) } : {}),
        limit: Number(value.limit),
      });
      return envelope({
        request: value,
        dataRevision: "multiple-runs",
        result: {
          items: listed.items,
          runs: listed.items,
          next_cursor: listed.nextCursor,
          nextCursor: listed.nextCursor,
        },
        dataQuality: { returned: listed.items.length, persistent: true },
      });
    },
    get_run_events: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!run) throw serviceNotFound("run", runId);
      const limit = Number(value.limit);
      const cursor = eventCursor(value.cursor);
      const events = await dependencies.runRepository.getEvents(runId, ownerSubject, {
        ...cursor,
        limit,
      });
      const nextCursor = events.length === limit && events.length
        ? Buffer.from(JSON.stringify({
            after: events.at(-1)!.createdAt,
            id: events.at(-1)!.id,
          }), "utf8").toString("base64url")
        : undefined;
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: {
          run_id: run.id,
          events,
          next_cursor: nextCursor,
          nextCursor,
        },
        dataQuality: { event_count: events.length, persistent: true },
      });
    },
    export_run_manifest: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!run) throw serviceNotFound("run", runId);
      const artifacts = await dependencies.artifacts.list(run.id);
      const existing = await dependencies.runRepository.getManifest(runId, ownerSubject);
      const capture = existing ?? await dependencies.runRepository.storeManifest(
        runId,
        ownerSubject,
        runManifest(run, artifacts),
      );
      const manifest = recordValue(capture)?.finalized === true
        ? capture
        : await dependencies.runRepository.finalizeManifest(
          runId,
          ownerSubject,
          finalizedRunManifest(capture, run, artifacts),
        );
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run_id: run.id, manifest, immutable: true },
        dataQuality: { manifest: "stored", immutable: true },
      });
    },
    update_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      if (!mcpVisibleRun(await dependencies.runRepository.get(runId, ownerSubject))) {
        throw serviceNotFound("run", runId);
      }
      if (value.name !== undefined) {
        await dependencies.runRepository.rename(
          runId,
          ownerSubject,
          String(value.name),
        );
      }
      if (value.tags !== undefined) {
        await dependencies.runRepository.setTags(
          runId,
          ownerSubject,
          value.tags as string[],
        );
      }
      if (value.archived !== undefined) {
        if (value.archived) {
          await dependencies.runRepository.archive(runId, ownerSubject);
        } else {
          await dependencies.runRepository.unarchive(runId, ownerSubject);
        }
      }
      const run = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!run) throw serviceNotFound("run", runId);
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run },
        dataQuality: { persistent: true },
      });
    },
    duplicate_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const source = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!source) throw serviceNotFound("run", runId);
      if (["queued", "running", "cancel_requested"].includes(source.status)) {
        throw new ServiceError({
          code: "RUN_NOT_TERMINAL",
          message: "진행 중인 run은 완료·실패·취소 후 복제할 수 있습니다.",
          retryable: false,
        });
      }
      const clone = await dependencies.runRepository.create({
        kind: source.kind,
        ownerSubject,
        requestHash: requestHash({ duplicate_of: source.id, nonce: randomUUID() }),
        dataRevision: source.dataRevision,
        engineVersion: source.engineVersion,
        config: source.input,
        totalCandidates: source.totalCandidates,
        name: (
          value.name ? String(value.name) : `${source.name ?? source.kind} 복사본`
        ).slice(0, 200),
        tags: source.tags,
        replayOf: source.id,
        manifest: {
          ...(recordValue(source.manifest) ?? runManifest(source, [])),
          finalized: false,
          duplicated_from: source.id,
        },
      });
      if (!await dependencies.runRepository.markRunning(clone.id)) {
        throw new ServiceError({
          code: "RUN_DUPLICATE_FAILED",
          message: "run 복제 레코드를 준비하지 못했습니다.",
          retryable: true,
        });
      }
      let optimizationCandidatesCopied = 0;
      if (source.status === "completed") {
        const descriptors = await dependencies.artifacts.list(source.id);
        for (const descriptor of descriptors) {
          const artifact = await dependencies.artifacts.get(source.id, descriptor.type);
          if (artifact) {
            await dependencies.artifacts.put({
              runId: clone.id,
              type: descriptor.type,
              content: artifact.content,
              rowCount: descriptor.rowCount,
              dataRevision: source.dataRevision,
            });
          }
        }
        if (source.kind === "optimization") {
          const settings = recordValue(source.input) ?? {};
          const candidateCount = await dependencies.optimizationRepository
            .candidateCount(source.id);
          const candidates = await dependencies.optimizationRepository.listCandidates(
            source.id,
            Math.max(1, candidateCount),
          );
          await dependencies.optimizationRepository.createRun({
            runId: clone.id,
            objective: String(settings.objective ?? "robust_score"),
            seed: String(settings.seed ?? "unknown"),
            candidateBudget: Number(settings.candidateBudget ?? candidates.length),
            objectiveVersion: source.engineVersion,
            settings,
          });
          await dependencies.optimizationRepository.putCandidates(
            candidates.map((candidate) => ({
              runId: clone.id,
              rank: candidate.rank,
              weights: candidate.weights,
              metrics: candidate.metrics,
              score: candidate.score,
              pareto: candidate.pareto,
            })),
          );
          optimizationCandidatesCopied = candidates.length;
        }
        await dependencies.runRepository.complete(
          clone.id,
          source.summary,
          source.result,
          source.warnings,
        );
      } else if (source.status === "cancelled") {
        await dependencies.runRepository.cancel(
          clone.id,
          source.summary,
          source.warnings,
        );
      } else {
        await dependencies.runRepository.fail(
          clone.id,
          source.error,
          source.warnings,
        );
      }
      await dependencies.runRepository.addEvent(
        clone.id,
        "duplicated_from",
        { run_id: source.id },
      );
      const stored = await dependencies.runRepository.get(clone.id, ownerSubject);
      if (!stored) throw serviceNotFound("run", clone.id);
      return envelope({
        request: value,
        dataRevision: stored.dataRevision,
        result: { run: stored, duplicated_from: source.id },
        dataQuality: {
          artifacts_copied: source.status === "completed",
          optimization_candidates_copied: optimizationCandidatesCopied,
        },
      });
    },
    delete_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!run) throw serviceNotFound("run", runId);
      const deleted = await dependencies.runRepository.softDelete(runId, ownerSubject);
      if (!deleted) {
        throw new ServiceError({
          code: "RUN_NOT_TERMINAL",
          message: "진행 중인 run은 취소·종료 후 삭제할 수 있습니다.",
          retryable: false,
        });
      }
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run_id: runId, deleted: true },
        dataQuality: { soft_delete: true },
      });
    },
    rerun_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const source = mcpVisibleRun(
        await dependencies.runRepository.get(runId, ownerSubject),
      );
      if (!source) throw serviceNotFound("run", runId);
      if (["queued", "running", "cancel_requested"].includes(source.status)) {
        throw new ServiceError({
          code: "RUN_ALREADY_ACTIVE",
          message: "진행 중인 run은 다시 실행할 수 없습니다.",
          retryable: false,
        });
      }
      const storedInput = recordValue(source.input);
      if (!storedInput) {
        throw new ServiceError({
          code: "RUN_INPUT_UNAVAILABLE",
          message: "재실행할 저장 입력이 없습니다.",
          retryable: false,
        });
      }
      const replayTool = source.kind === "technical_strategy"
        && storedInput.mode === "signal_only"
        ? "analyze_technical_signals"
        : REPLAY_TOOL_BY_KIND[source.kind];
      if (!replayTool) {
        throw new ServiceError({
          code: "RUN_REPLAY_UNSUPPORTED",
          message: `${source.kind} run은 아직 저장된 실행 재실행을 지원하지 않습니다.`,
          retryable: false,
          details: { run_id: source.id, run_kind: source.kind },
        });
      }
      const replayBase = source.kind === "technical_analysis"
        ? (() => {
            const {
              cacheSchemaVersion: _cacheSchemaVersion,
              indicator_engine_version: _indicatorEngineVersion,
              _replayNonce: _previousReplayNonce,
              _replayOf: _previousReplaySource,
              ...technicalInput
            } = storedInput;
            return toolSchemas.analyze_technical_signals.parse({
              ...technicalInput,
              responseMode: "full_series",
            });
          })()
        : source.kind === "technical_strategy"
          ? (() => {
              const {
                cacheSchemaVersion: _cacheSchemaVersion,
                indicator_engine_version: _indicatorEngineVersion,
                mode: _mode,
                _replayNonce: _previousReplayNonce,
                _replayOf: _previousReplaySource,
                ...strategyInput
              } = storedInput;
              return resolvedPresetExecutionSchemas[
                replayTool as "analyze_technical_signals"
                  | "run_technical_strategy_backtest"
              ].parse(strategyInput);
            })()
          : storedInput;
      const replayInput = {
        ...replayBase,
        _replayNonce: randomUUID(),
        _replayOf: source.id,
      };
      const invoked = await invokeTool(replayTool, replayInput, ownerSubject);
      const replayId = nestedRunId(invoked);
      if (!replayId || replayId === source.id) {
        throw new ServiceError({
          code: "RUN_REPLAY_FAILED",
          message: "새 재실행 run을 만들지 못했습니다.",
          retryable: true,
        });
      }
      if (source.name) {
        await dependencies.runRepository.rename(
          replayId,
          ownerSubject,
          `${source.name} 재실행`,
        );
      }
      if (source.tags.length) {
        await dependencies.runRepository.setTags(
          replayId,
          ownerSubject,
          source.tags,
        );
      }
      await dependencies.runRepository.linkReplay(
        replayId,
        ownerSubject,
        source.id,
      );
      const replay = await dependencies.runRepository.get(replayId, ownerSubject);
      if (!replay) throw serviceNotFound("run", replayId);
      return envelope({
        request: value,
        dataRevision: replay.dataRevision,
        result: { run: replay, replay_of: source.id },
        dataQuality: { fresh_execution: true },
      });
    },
  };
}
