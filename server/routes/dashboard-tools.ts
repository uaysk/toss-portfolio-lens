import { Router, type RequestHandler, type Response } from "express";
import { setNoStore } from "../auth.js";
import {
  createDashboardAnalysisExecutor,
  dashboardAnalysisError,
  parseDashboardRunId,
} from "../dashboard-analysis.js";
import { McpResourceRegistry } from "../mcp/resources.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import {
  createToolHandlers,
  type McpToolDependencies,
} from "../mcp/tools/handlers.js";
import {
  ARTIFACT_TYPES,
  type ArtifactType,
} from "../repositories/artifact-repository.js";
import type { ArtifactService } from "../services/artifact-service.js";
import { ServiceError } from "../services/service-envelope.js";
import type { RunService } from "../services/run-service.js";
import type { TechnicalTradeMarkerService } from "../services/technical-trade-marker-service.js";
import { enforceToolRequestLimits } from "../services/tool-request-limits.js";

export type DashboardToolsRouteDependencies = {
  authenticate: RequestHandler;
  tools: McpToolDependencies;
  technicalTradeMarkerService: TechnicalTradeMarkerService;
  ownerSubject?: string;
};

function queryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(queryValues);
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function queryValue(value: unknown): string | undefined {
  return queryValues(value)[0];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sendDashboardAnalysisError(response: Response, error: unknown): void {
  const adapted = dashboardAnalysisError(error);
  if (error instanceof ServiceError) {
    if (["PRESET_NOT_FOUND", "CANDIDATE_NOT_FOUND"].includes(error.detail.code)) {
      adapted.status = 404;
    }
    if (["PRESET_REVISION_CONFLICT", "RUN_NOT_TERMINAL", "RUN_ALREADY_ACTIVE"]
      .includes(error.detail.code)) {
      adapted.status = 409;
    }
  }
  if (adapted.status >= 500) {
    console.error("[dashboard-analysis]", error instanceof Error ? error.message : error);
  }
  response.status(adapted.status).json(adapted.body);
}

function dashboardRunResponse(
  run: NonNullable<Awaited<ReturnType<RunService["get"]>>>,
  includeResult = false,
) {
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    progress: run.progress,
    completedCandidates: run.completedCandidates,
    totalCandidates: run.totalCandidates,
    ...(run.currentValidationWindow
      ? { currentValidationWindow: run.currentValidationWindow }
      : {}),
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(includeResult && run.result !== undefined ? { result: run.result } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    warnings: run.warnings,
  };
}

export function createDashboardToolsRouter({
  authenticate,
  tools,
  technicalTradeMarkerService,
  ownerSubject = "owner",
}: DashboardToolsRouteDependencies): Router {
  const router = Router();
  const executeDashboardAnalysis = createDashboardAnalysisExecutor(tools);
  const managementHandlers = createToolHandlers(tools);
  const artifactTypes = new Set<ArtifactType>(ARTIFACT_TYPES);
  const { runs, artifacts, resources } = tools;

  async function executeDashboardManagement(name: ToolName, input: unknown): Promise<unknown> {
    const parsed = toolSchemas[name].parse(input);
    enforceToolRequestLimits(parsed, tools);
    return managementHandlers[name](parsed, ownerSubject);
  }

  router.post("/api/portfolio/advanced/:operation", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const result = await executeDashboardAnalysis(
        String(request.params.operation ?? ""),
        request.body,
        ownerSubject,
      );
      const runResult = (result as {
        result?: {
          status?: string;
          result?: unknown;
          result_externalized?: boolean;
        };
      })?.result;
      if (runResult?.result !== undefined && artifacts.shouldExternalize(runResult.result)) {
        delete runResult.result;
        runResult.result_externalized = true;
      }
      const status = runResult?.status;
      response
        .status(status && ["queued", "running", "cancel_requested"].includes(status) ? 202 : 200)
        .json(result);
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.get("/api/portfolio/advanced/runs/:runId", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const runId = parseDashboardRunId(request.params.runId);
      const run = await runs.get(runId, ownerSubject);
      if (!run) {
        response.status(404).json({
          error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." },
        });
        return;
      }
      response.json(dashboardRunResponse(run));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.get(
    "/api/portfolio/advanced/runs/:runId/result",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        const runId = parseDashboardRunId(request.params.runId);
        const run = await runs.get(runId, ownerSubject);
        if (!run) {
          response.status(404).json({
            error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." },
          });
          return;
        }
        const artifactList = await artifacts.list(run.id);
        const resultExternalized = run.result !== undefined && artifacts.shouldExternalize(run.result);
        response
          .status(["queued", "running", "cancel_requested"].includes(run.status) ? 202 : 200)
          .json({
            ...dashboardRunResponse(run, !resultExternalized),
            ...(resultExternalized ? { resultExternalized: true } : {}),
            artifacts: artifactList,
          });
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.post(
    "/api/portfolio/advanced/runs/:runId/cancel",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        const runId = parseDashboardRunId(request.params.runId);
        const accepted = await runs.cancel(runId, ownerSubject);
        const run = await runs.get(runId, ownerSubject);
        if (!run) {
          response.status(404).json({
            error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." },
          });
          return;
        }
        response.json({
          ...dashboardRunResponse(run),
          cancelRequested: accepted,
        });
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get(
    "/api/portfolio/advanced/runs/:runId/artifacts/:type",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        const runId = parseDashboardRunId(request.params.runId);
        const type = String(request.params.type ?? "") as ArtifactType;
        if (!artifactTypes.has(type)) {
          response.status(404).json({
            error: {
              code: "ARTIFACT_NOT_FOUND",
              message: "지원하지 않는 결과 자료입니다.",
            },
          });
          return;
        }
        const run = await runs.get(runId, ownerSubject);
        if (!run) {
          response.status(404).json({
            error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." },
          });
          return;
        }
        const artifact = await artifacts.get(run.id, type);
        if (!artifact) {
          response.status(404).json({
            error: { code: "ARTIFACT_NOT_FOUND", message: "결과 자료를 찾을 수 없습니다." },
          });
          return;
        }
        response.json(artifact);
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get(
    "/api/portfolio/advanced/resources/market/:requestHash",
    authenticate,
    (request, response) => {
      setNoStore(response);
      const requestHash = String(request.params.requestHash ?? "");
      if (!/^[a-f0-9]{64}$/.test(requestHash)) {
        response.status(400).json({
          error: {
            code: "INVALID_RESOURCE_ID",
            message: "시장 자료 식별자가 올바르지 않습니다.",
          },
        });
        return;
      }
      const stored = (resources as McpResourceRegistry).getMarket(requestHash, ownerSubject);
      if (!stored) {
        response.status(404).json({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "시장 자료가 만료되었거나 없습니다.",
          },
        });
        return;
      }
      response.json({ descriptor: stored.descriptor, data: stored.content });
    },
  );

  router.get("/api/portfolio/technical/trades", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = queryValue(request.query.account) ?? "";
    const fromDate = queryValue(request.query.from);
    const toDate = queryValue(request.query.to);
    const symbols = queryValues(request.query.symbols).map((symbol) => symbol.toUpperCase());
    try {
      response.json(await technicalTradeMarkerService.getMarkers({
        accountId,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
        ...(symbols.length ? { symbols } : {}),
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.post("/api/portfolio/tools/:toolName", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const name = String(request.params.toolName ?? "");
      if (!Object.hasOwn(toolSchemas, name)) {
        response.status(404).json({
          error: {
            code: "TOOL_NOT_FOUND",
            message: "지원하지 않는 portfolio 도구입니다.",
          },
        });
        return;
      }
      const result = await executeDashboardManagement(name as ToolName, request.body);
      const status = objectValue(objectValue(result).result).status;
      response
        .status(typeof status === "string"
          && ["queued", "running", "cancel_requested"].includes(status)
          ? 202
          : 200)
        .json(result);
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.get("/api/portfolio/runs", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const archivedQuery = queryValue(request.query.archived);
      const archived = archivedQuery === "true" || archivedQuery === "archived"
        ? "archived"
        : archivedQuery === "all"
          ? "all"
          : "active";
      response.json(await executeDashboardManagement("list_runs", {
        ...(queryValue(request.query.query)
          ? { query: queryValue(request.query.query) }
          : {}),
        kinds: [...queryValues(request.query.kind), ...queryValues(request.query.kinds)],
        statuses: [...queryValues(request.query.status), ...queryValues(request.query.statuses)],
        tags: [...queryValues(request.query.tag), ...queryValues(request.query.tags)],
        archived,
        ...(queryValue(request.query.cursor)
          ? { cursor: queryValue(request.query.cursor) }
          : {}),
        limit: Number(queryValue(request.query.limit) ?? 25),
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.patch("/api/portfolio/runs/:runId", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      response.json(await executeDashboardManagement("update_run", {
        ...objectValue(request.body),
        runId: request.params.runId,
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.delete("/api/portfolio/runs/:runId", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      response.json(await executeDashboardManagement("delete_run", {
        runId: request.params.runId,
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.post(
    "/api/portfolio/runs/:runId/duplicate",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.status(201).json(await executeDashboardManagement("duplicate_run", {
          ...objectValue(request.body),
          runId: request.params.runId,
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.post("/api/portfolio/runs/:runId/rerun", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const result = await executeDashboardManagement("rerun_run", {
        runId: request.params.runId,
      });
      const run = objectValue(objectValue(result).result).run;
      const status = objectValue(run).status;
      response
        .status(typeof status === "string"
          && ["queued", "running", "cancel_requested"].includes(status)
          ? 202
          : 200)
        .json(result);
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.get(
    "/api/portfolio/runs/:runId/events",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.json(await executeDashboardManagement("get_run_events", {
          runId: request.params.runId,
          ...(queryValue(request.query.cursor)
            ? { cursor: queryValue(request.query.cursor) }
            : {}),
          limit: Number(queryValue(request.query.limit) ?? 100),
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get(
    "/api/portfolio/runs/:runId/manifest",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.json(await executeDashboardManagement("export_run_manifest", {
          runId: request.params.runId,
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get("/api/portfolio/presets", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      response.json(await executeDashboardManagement("list_portfolio_presets", {
        ...(queryValue(request.query.query)
          ? { query: queryValue(request.query.query) }
          : {}),
        tags: [...queryValues(request.query.tag), ...queryValues(request.query.tags)],
        ...(queryValue(request.query.cursor)
          ? { cursor: queryValue(request.query.cursor) }
          : {}),
        limit: Number(queryValue(request.query.limit) ?? 25),
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.post("/api/portfolio/presets", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      response
        .status(201)
        .json(await executeDashboardManagement("create_portfolio_preset", request.body));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.post("/api/portfolio/presets/import", authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const body = objectValue(request.body);
      response.status(201).json(await executeDashboardManagement("import_portfolio_presets", {
        document: body.document,
        conflictMode: body.conflictMode ?? "rename",
      }));
    } catch (error) {
      sendDashboardAnalysisError(response, error);
    }
  });

  router.get(
    "/api/portfolio/presets/:presetId",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.json(await executeDashboardManagement("get_portfolio_preset", {
          presetId: request.params.presetId,
          includeHistory: queryValue(request.query.includeHistory) === "true",
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get(
    "/api/portfolio/presets/:presetId/history",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.json(await executeDashboardManagement("get_portfolio_preset", {
          presetId: request.params.presetId,
          includeHistory: true,
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.patch(
    "/api/portfolio/presets/:presetId",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        const body = objectValue(request.body);
        response.json(await executeDashboardManagement("update_portfolio_preset", {
          ...body,
          presetId: request.params.presetId,
          revision: body.revision ?? body.version,
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.delete(
    "/api/portfolio/presets/:presetId",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.json(await executeDashboardManagement("delete_portfolio_preset", {
          presetId: request.params.presetId,
        }));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.post(
    "/api/portfolio/presets/:presetId/duplicate",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        response.status(201).json(await executeDashboardManagement(
          "duplicate_portfolio_preset",
          {
            ...objectValue(request.body),
            presetId: request.params.presetId,
          },
        ));
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  router.get(
    "/api/portfolio/presets/:presetId/export",
    authenticate,
    async (request, response) => {
      setNoStore(response);
      try {
        const output = objectValue(await executeDashboardManagement(
          "export_portfolio_preset",
          { presetId: request.params.presetId },
        ));
        const document = objectValue(output.result).document;
        response.json(document);
      } catch (error) {
        sendDashboardAnalysisError(response, error);
      }
    },
  );

  return router;
}
