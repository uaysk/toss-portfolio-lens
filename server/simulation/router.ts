import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { setNoStore } from "../auth.js";
import type { SseConnectionTracker } from "../lifecycle.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  SIMULATION_RUN_EVENT_SCHEMA_VERSION,
  createSimulationStartRequestSchema,
  type SimulationRunEventStatus,
  type SimulationRunEventV1,
  type SimulationStartRequest,
} from "./contracts.js";
import type { PortfolioRunStatus } from "../repositories/run-repository.js";
import { ScannerCriterionSchema, type ScannerCriterion } from "../scalping/contracts.js";
import type { SimulationHistoryListInput } from "./simulation-service.js";
import {
  SimulationRunEventHub,
  SimulationRunEventsBusyError,
} from "./run-event-stream.js";

export type SimulationCandidatesInput = {
  criterion: ScannerCriterion;
};

export type SimulationRouterService = {
  status(enabled?: boolean): unknown | Promise<unknown>;
  candidates?(
    input: SimulationCandidatesInput,
    ownerSubject: string,
  ): Promise<unknown>;
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
  events?: SimulationRunEventHub;
  sseConnections?: Pick<SseConnectionTracker, "track">;
  config: {
    enabled: boolean;
    maxDurationMinutes: number;
    ownerSubject?: string;
    heartbeatMs?: number;
    backpressureEventLimit?: number;
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
const CandidatesQuerySchema = z.object({
  criterion: ScannerCriterionSchema.default("volatility"),
}).strict();

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

const TERMINAL_STATUSES = new Set<SimulationRunEventStatus>([
  "cancelled",
  "completed",
  "failed",
]);

function simulationStatus(value: unknown): SimulationRunEventStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const run = record.run && typeof record.run === "object" && !Array.isArray(record.run)
    ? record.run as Record<string, unknown>
    : {};
  const snapshot = record.snapshot
    && typeof record.snapshot === "object"
    && !Array.isArray(record.snapshot)
    ? record.snapshot as Record<string, unknown>
    : {};
  const candidate = run.status ?? record.status ?? snapshot.phase;
  return typeof candidate === "string"
    && [
      "queued",
      "running",
      "cancel_requested",
      "cancelled",
      "completed",
      "failed",
    ].includes(candidate)
    ? candidate as SimulationRunEventStatus
    : undefined;
}

function lastEventRevision(request: Request): number | undefined {
  const raw = request.get("Last-Event-ID")
    ?? (typeof request.query.lastEventId === "string" ? request.query.lastEventId : undefined);
  if (!raw?.trim()) return undefined;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function writeSimulationEvent(response: Response, event: SimulationRunEventV1): boolean {
  return response.write(
    `id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function streamUnavailable(response: Response): void {
  setNoStore(response);
  response.status(503).json({
    error: {
      code: "simulation-events-unavailable",
      message: "모의투자 실시간 이벤트 스트림을 사용할 수 없습니다.",
      retryable: true,
    },
  });
}

export function createSimulationRouter(dependencies: SimulationRouterDependencies) {
  const requestSchema = createSimulationStartRequestSchema({
    maxDurationMinutes: dependencies.config.maxDurationMinutes,
  });
  const ownerSubject = dependencies.config.ownerSubject?.trim() || "owner";
  const heartbeatMs = dependencies.config.heartbeatMs ?? 15_000;
  const backpressureEventLimit = dependencies.config.backpressureEventLimit ?? 128;
  if (ownerSubject.length > 128) throw new Error("Simulation owner subject is too long.");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) {
    throw new Error("Simulation SSE heartbeat must be in 1000..=60000ms.");
  }
  if (!Number.isInteger(backpressureEventLimit)
    || backpressureEventLimit < 2
    || backpressureEventLimit > 10_000) {
    throw new Error("Simulation SSE backpressure limit must be in 2..=10000.");
  }

  const router = express.Router();
  router.use(dependencies.authenticate);

  router.get("/status", async (_request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) {
      response.json({
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        enabled: false,
        capabilities: {
          realOrder: false,
          mcp: false,
          autonomousPaperTrading: false,
          orderApiDependency: false,
        },
        credentials: {
          configured: false,
          signedReadSucceeded: false,
        },
        executionGates: {
          paper: false,
          testnet: false,
          live: false,
          realOrder: false,
        },
        workers: {
          kronos_base: { status: "unavailable", precision: "unknown" },
          fincast: { status: "unavailable", precision: "unknown" },
        },
      });
      return;
    }
    try {
      response.json(await dependencies.service.status(true));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/candidates", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    if (!dependencies.service.candidates) {
      response.status(503).json({
        error: {
          code: "crypto-scanner-unavailable",
          message: "암호화폐 선물 스캐너가 설정되지 않았습니다.",
        },
      });
      return;
    }
    try {
      response.json(await dependencies.service.candidates(
        CandidatesQuerySchema.parse(request.query),
        ownerSubject,
      ));
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

  router.get("/runs/:runId/events", async (request, response) => {
    if (!dependencies.config.enabled || !dependencies.service) return disabled(response);
    if (!dependencies.events) return streamUnavailable(response);

    let runId: string;
    let current: unknown;
    try {
      runId = RunIdSchema.parse(request.params.runId);
      current = await dependencies.service.get(runId, ownerSubject);
      if (notFound(current)) return missing(response);
    } catch (error) {
      return sendError(response, error);
    }

    const status = simulationStatus(current);
    const terminal = status !== undefined && TERMINAL_STATUSES.has(status);
    const requestedRevision = lastEventRevision(request);
    let lastSent = requestedRevision ?? 0;
    let latestStatus = status;
    let ended = false;
    let blocked = false;
    let replaying = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let release: () => void = () => undefined;
    let untrack: () => void = () => undefined;
    const pending: SimulationRunEventV1[] = [];
    const queuedDuringReplay: SimulationRunEventV1[] = [];

    const cleanup = () => {
      if (ended) return;
      ended = true;
      if (heartbeat) clearInterval(heartbeat);
      request.off("close", cleanup);
      response.off("close", cleanup);
      response.off("drain", drain);
      const releaseSubscription = release;
      release = () => undefined;
      const unregister = untrack;
      untrack = () => undefined;
      releaseSubscription();
      unregister();
    };

    const closeForBackpressure = () => {
      if (!response.writableEnded && !response.destroyed) response.end();
      cleanup();
    };

    const send = (event: SimulationRunEventV1) => {
      if (ended || event.revision <= lastSent) return;
      latestStatus = simulationStatus(event.payload) ?? latestStatus;
      if (blocked) {
        if (pending.length >= backpressureEventLimit - 1) {
          closeForBackpressure();
          return;
        }
        pending.push(event);
        return;
      }
      blocked = !writeSimulationEvent(response, event);
      lastSent = event.revision;
    };

    const sendLive = (event: SimulationRunEventV1) => {
      if (replaying) queuedDuringReplay.push(event);
      else send(event);
    };

    const drain = () => {
      blocked = false;
      while (!blocked && pending.length) send(pending.shift()!);
    };

    try {
      release = dependencies.events.subscribe(runId, ownerSubject, sendLive);
    } catch (error) {
      if (error instanceof SimulationRunEventsBusyError) {
        setNoStore(response);
        response.setHeader("Retry-After", "5");
        response.status(503).json({
          error: {
            code: error.code,
            message: "모의투자 이벤트 연결이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
            retryable: error.retryable,
          },
        });
        return;
      }
      return sendError(response, error);
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    response.on("drain", drain);
    request.on("close", cleanup);
    response.on("close", cleanup);
    untrack = dependencies.sseConnections?.track(response, cleanup) ?? (() => undefined);

    let replay: SimulationRunEventV1[];
    if (requestedRevision === undefined) {
      const latest = dependencies.events.latest(runId, ownerSubject);
      if (terminal && latest?.type === "terminal") {
        replay = [{ ...latest, payload: current }];
      } else {
        const snapshot = dependencies.events.publishSnapshot({
          runId,
          ownerSubject,
          ...(status ? { status } : {}),
          payload: current,
        });
        const terminalEvent = terminal && status
          ? dependencies.events.publishTerminal({
            runId,
            ownerSubject,
            status: status as Extract<
              SimulationRunEventStatus,
              "cancelled" | "completed" | "failed"
            >,
            payload: current,
          })
          : undefined;
        replay = [snapshot, terminalEvent].filter(
          (event): event is SimulationRunEventV1 => event !== undefined,
        );
      }
      lastSent = 0;
    } else {
      let latest = dependencies.events.latest(runId, ownerSubject);
      if (!latest) {
        dependencies.events.publishSnapshot({
          runId,
          ownerSubject,
          ...(status ? { status } : {}),
          payload: current,
        });
        if (terminal && status) {
          dependencies.events.publishTerminal({
            runId,
            ownerSubject,
            status: status as Extract<
              SimulationRunEventStatus,
              "cancelled" | "completed" | "failed"
            >,
            payload: current,
          });
        }
        latest = dependencies.events.latest(runId, ownerSubject);
      }
      const resumeAfter = latest && requestedRevision > latest.revision
        ? 0
        : requestedRevision;
      replay = dependencies.events.eventsAfter(runId, ownerSubject, resumeAfter);
      if (replay[0] && replay[0].revision > resumeAfter + 1) {
        if (terminal) {
          replay = latest ? [{ ...latest, payload: current }] : [];
        } else {
          const snapshot = dependencies.events.publishSnapshot({
            runId,
            ownerSubject,
            ...(status ? { status } : {}),
            payload: current,
          });
          replay = snapshot ? [snapshot] : latest ? [latest] : [];
        }
      }
      lastSent = resumeAfter;
    }

    for (const event of replay.sort((left, right) => left.revision - right.revision)) send(event);
    replaying = false;
    for (const event of queuedDuringReplay.sort(
      (left, right) => left.revision - right.revision,
    )) send(event);

    if (ended) return;
    heartbeat = setInterval(() => {
      if (ended || blocked || lastSent < 1) return;
      const heartbeatEvent: SimulationRunEventV1 = {
        schemaVersion: SIMULATION_RUN_EVENT_SCHEMA_VERSION,
        runId,
        revision: lastSent,
        type: "heartbeat",
        emittedAt: new Date().toISOString(),
        payload: latestStatus ? { status: latestStatus } : null,
      };
      blocked = !writeSimulationEvent(response, heartbeatEvent);
    }, heartbeatMs);
    heartbeat.unref();
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
