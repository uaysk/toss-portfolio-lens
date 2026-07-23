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

export type SimulationRouterService = {
  status(enabled?: boolean): unknown | Promise<unknown>;
  start(input: SimulationStartRequest, ownerSubject: string): Promise<unknown>;
  current(ownerSubject: string): Promise<unknown | undefined>;
  get(runId: string, ownerSubject: string): Promise<unknown | undefined>;
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
