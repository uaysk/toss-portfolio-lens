import path from "node:path";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { setNoStore } from "../auth.js";
import {
  isTerminalQualificationStatus,
  type QualificationEvent,
  type QualificationState,
} from "../qualification/contracts.js";
import {
  QualificationRunNotFoundError,
  QualificationRunStore,
} from "../qualification/store.js";
import type { SseConnectionTracker } from "../lifecycle.js";

export type AiQualificationRouterDependencies = {
  authenticate: RequestHandler;
  runRoot?: string;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  sseConnections?: Pick<SseConnectionTracker, "track">;
};

function lastEventSequence(request: Request): number {
  const raw = request.get("last-event-id")
    ?? (typeof request.query.lastEventId === "string" ? request.query.lastEventId : "");
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeEvent(response: Response, event: QualificationEvent): boolean {
  return response.write(
    `id: ${event.sequence}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function writeSnapshot(response: Response, state: QualificationState): boolean {
  return response.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
}

function sendError(response: Response, error: unknown): void {
  setNoStore(response);
  if (error instanceof QualificationRunNotFoundError) {
    response.status(404).json({
      error: {
        code: "qualification-run-not-found",
        message: "모니터링할 AI 검증 실행을 찾지 못했습니다.",
      },
    });
    return;
  }
  console.warn(
    "[ai-qualification] progress read failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  response.status(500).json({
    error: {
      code: "qualification-state-invalid",
      message: "AI 검증 상태와 대시보드 계약이 맞지 않습니다. 대시보드 서버 로그를 확인해 주세요.",
    },
  });
}

export function createAiQualificationRouter(
  dependencies: AiQualificationRouterDependencies,
): Router {
  const runRoot = dependencies.runRoot
    ?? process.env.AI_QUALIFICATION_RUN_ROOT?.trim()
    ?? path.resolve(process.cwd(), "data/ai-qualification");
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
  const heartbeatMs = dependencies.heartbeatMs ?? 15_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 10_000) {
    throw new Error("AI qualification poll interval must be in 250..=10000ms.");
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) {
    throw new Error("AI qualification heartbeat must be in 1000..=60000ms.");
  }
  const store = new QualificationRunStore(path.resolve(runRoot));
  const router = Router();
  router.use("/api/ai-qualification", dependencies.authenticate);

  router.get("/api/ai-qualification/runs/latest", async (_request, response) => {
    try {
      setNoStore(response);
      response.json(await store.latest());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/api/ai-qualification/runs/:runId", async (request, response) => {
    try {
      setNoStore(response);
      const state = await store.state(request.params.runId ?? "");
      response.json({
        state,
        events: await store.events(state.runId),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/api/ai-qualification/runs/:runId/artifact", async (request, response) => {
    try {
      const requestedPath = typeof request.query.path === "string"
        ? request.query.path
        : "";
      const artifact = await store.artifact(request.params.runId ?? "", requestedPath);
      setNoStore(response);
      response.type(path.extname(artifact.path) || "application/octet-stream");
      response.send(artifact.payload);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/api/ai-qualification/runs/:runId/events", async (request, response) => {
    const runId = request.params.runId ?? "";
    let state: QualificationState;
    try {
      state = await store.state(runId);
    } catch (error) {
      sendError(response, error);
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    let ended = false;
    let blocked = false;
    let sequence = lastEventSequence(request);
    let updatedAt = "";
    let polling = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let untrack: () => void = () => undefined;

    const cleanup = () => {
      if (ended) return;
      ended = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      response.off("drain", onDrain);
      const unregister = untrack;
      untrack = () => undefined;
      unregister();
    };
    const onDrain = () => {
      blocked = false;
    };
    const update = async () => {
      if (ended || blocked || polling) return;
      polling = true;
      try {
        const nextState = await store.state(runId);
        if (nextState.updatedAt !== updatedAt) {
          blocked = !writeSnapshot(response, nextState);
          updatedAt = nextState.updatedAt;
        }
        if (!blocked) {
          const events = await store.events(runId, sequence);
          for (const event of events) {
            if (ended || blocked) break;
            blocked = !writeEvent(response, event);
            sequence = event.sequence;
          }
        }
        if (isTerminalQualificationStatus(nextState.status) && !blocked) {
          response.write(`event: terminal\ndata: ${JSON.stringify({
            runId,
            status: nextState.status,
          })}\n\n`);
        }
      } catch (error) {
        if (!ended) {
          response.write(`event: unavailable\ndata: ${JSON.stringify({
            code: "qualification-progress-unavailable",
            message: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
          })}\n\n`);
        }
      } finally {
        polling = false;
      }
    };

    response.on("drain", onDrain);
    request.on("close", cleanup);
    response.on("close", cleanup);
    untrack = dependencies.sseConnections?.track(response, cleanup) ?? (() => undefined);
    await update();
    if (ended) return;
    pollTimer = setInterval(() => void update(), pollIntervalMs);
    pollTimer.unref();
    heartbeatTimer = setInterval(() => {
      if (!ended && !blocked) blocked = !response.write(`: heartbeat ${Date.now()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref();
  });

  return router;
}
