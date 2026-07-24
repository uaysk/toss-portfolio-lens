import express, {
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { setNoStore } from "../auth.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  createSimulationStartRequestSchema,
  type SimulationStartRequest,
} from "./contracts.js";
import type { PortfolioRunStatus } from "../repositories/run-repository.js";
import type { SimulationHistoryListInput } from "./simulation-service.js";

export type SimulationRouterService = {
  status(enabled?: boolean): unknown | Promise<unknown>;
  start(input: SimulationStartRequest, ownerSubject: string): Promise<unknown>;
  current(ownerSubject: string): Promise<unknown | undefined>;
  list(input: SimulationHistoryListInput, ownerSubject: string): Promise<unknown>;
  get(runId: string, ownerSubject: string): Promise<unknown | undefined>;
  report(runId: string, ownerSubject: string): Promise<unknown | undefined>;
  cancel(runId: string, ownerSubject: string): Promise<unknown | undefined>;
};

export type SimulationRouterDependencies = {
  authenticate: RequestHandler;
  service?: SimulationRouterService;
  config: {
    enabled: boolean;
    maxDurationMinutes: number;
    ownerSubject?: string;
  };
};

const RunIdSchema = z.string().uuid();
const RunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed",
]);
const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  status: z.preprocess((value) => {
    if (value === undefined) return undefined;
    const raw = Array.isArray(value) ? value : [value];
    return raw.flatMap((item) => (
      typeof item === "string"
        ? item.split(",").map((entry) => entry.trim()).filter(Boolean)
        : [item]
    ));
  }, z.array(RunStatusSchema).min(1).max(6).optional()),
}).strict().transform((input): SimulationHistoryListInput => ({
  limit: input.limit,
  ...(input.cursor ? { cursor: input.cursor } : {}),
  ...(input.status?.length
    ? { statuses: Array.from(new Set(input.status)) as PortfolioRunStatus[] }
    : {}),
}));

function disabled(response: Response): void {
  setNoStore(response);
  response.status(503).json({
    error: {
      code: "simulation-disabled",
      message: "AI 모의투자 기능이 설정되지 않았습니다.",
    },
  });
}

function missing(response: Response): void {
  setNoStore(response);
  response.status(404).json({
    error: {
      code: "simulation-run-not-found",
      message: "모의투자 실행을 찾을 수 없습니다.",
    },
  });
}

function sendError(response: Response, error: unknown): void {
  setNoStore(response);
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: {
        code: "invalid-simulation-request",
        message: "AI 모의투자 요청 값을 확인해 주세요.",
        issues: error.issues,
      },
    });
    return;
  }
  response.status(503).json({
    error: {
      code: "simulation-unavailable",
      message: "AI 모의투자 요청을 처리하지 못했습니다.",
    },
  });
}

function notFound(value: unknown): boolean {
  return value === undefined || value === null || value === false;
}

export function createSimulationRouter(dependencies: SimulationRouterDependencies) {
  const requestSchema = createSimulationStartRequestSchema({
    maxDurationMinutes: dependencies.config.maxDurationMinutes,
  });
  const ownerSubject = dependencies.config.ownerSubject?.trim() || "owner";
  if (ownerSubject.length > 128) throw new Error("Simulation owner subject is too long.");

  const router = express.Router();
  router.use(dependencies.authenticate);

  router.get("/status", async (_request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) {
      response.json({
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        enabled: false,
        capabilities: { realOrder: false, mcp: false, autonomousPaperTrading: false },
      });
      return;
    }
    try {
      response.json(await dependencies.service.status(true));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/runs", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      const result = await dependencies.service.start(requestSchema.parse(request.body), ownerSubject);
      response.status(202).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/runs", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      response.json(await dependencies.service.list(
        HistoryQuerySchema.parse(request.query),
        ownerSubject,
      ));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/runs/current", async (_request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      const result = await dependencies.service.current(ownerSubject);
      response.json(result ?? { run: null, snapshot: null });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/runs/:runId/report", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      const result = await dependencies.service.report(
        RunIdSchema.parse(request.params.runId),
        ownerSubject,
      );
      if (notFound(result)) return missing(response);
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/runs/:runId", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      const result = await dependencies.service.get(
        RunIdSchema.parse(request.params.runId),
        ownerSubject,
      );
      if (notFound(result)) return missing(response);
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/runs/:runId/cancel", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    try {
      const result = await dependencies.service.cancel(
        RunIdSchema.parse(request.params.runId),
        ownerSubject,
      );
      if (notFound(result)) return missing(response);
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
