import { Router, type Request, type RequestHandler, type Response } from "express";
import { setNoStore } from "../auth.js";
import type { SseConnectionTracker } from "../lifecycle.js";
import {
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  type PortfolioEventV1,
} from "../contracts/portfolio-events.js";
import {
  PortfolioLiveBusyError,
  type PortfolioLiveHub,
  type PortfolioLiveSubscription,
} from "../portfolio/live-hub.js";
import type { Portfolio } from "../toss.js";
import { TossApiError } from "../toss.js";

export type PortfolioRouteDependencies = {
  authenticate: RequestHandler;
  getPortfolio: (account?: string, force?: boolean) => Promise<Portfolio>;
  recordPortfolio: (portfolio: Portfolio) => Promise<void>;
  logError?: (scope: "history" | "portfolio", error: unknown) => void;
  live?: PortfolioLiveHub;
  sseConnections?: Pick<SseConnectionTracker, "track">;
  ownerSubject?: string;
  heartbeatMs?: number;
  backpressureEventLimit?: number;
};

function defaultLogError(scope: "history" | "portfolio", error: unknown): void {
  const message = error instanceof Error ? error.message : error;
  console.error(scope === "history" ? "[history] 일별 스냅샷 저장 실패:" : "[portfolio]", message);
}

function requestedAccount(request: Request): string {
  return typeof request.query.account === "string" ? request.query.account.trim() : "";
}

function requestedRevision(request: Request): number | undefined {
  const raw = request.get("Last-Event-ID")
    ?? (typeof request.query.lastEventId === "string" ? request.query.lastEventId : undefined);
  if (!raw?.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function writePortfolioEvent(response: Response, event: PortfolioEventV1): boolean {
  return response.write(
    `id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function sendPortfolioError(
  response: Response,
  error: unknown,
  logError: (scope: "history" | "portfolio", error: unknown) => void,
): void {
  setNoStore(response);
  if (error instanceof TossApiError) {
    const status = error.status === 400 || error.status === 404 || error.status === 429
      ? error.status
      : 502;
    response.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      },
    });
    return;
  }
  const message = error instanceof Error && error.name === "TimeoutError"
    ? "토스증권 응답 시간이 초과되었습니다."
    : "포트폴리오를 불러오는 중 예기치 못한 오류가 발생했습니다.";
  logError("portfolio", error);
  response.status(502).json({ error: { code: "portfolio-unavailable", message } });
}

export function createPortfolioRouter(dependencies: PortfolioRouteDependencies): Router {
  const router = Router();
  const logError = dependencies.logError ?? defaultLogError;
  const ownerSubject = dependencies.ownerSubject?.trim() || "owner";
  const heartbeatMs = dependencies.heartbeatMs ?? 15_000;
  const backpressureEventLimit = dependencies.backpressureEventLimit ?? 32;
  if (ownerSubject.length > 128) throw new Error("Portfolio owner subject is too long.");
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) {
    throw new Error("Portfolio SSE heartbeat must be in 1000..=60000ms.");
  }
  if (
    !Number.isSafeInteger(backpressureEventLimit)
    || backpressureEventLimit < 2
    || backpressureEventLimit > 1_000
  ) {
    throw new Error("Portfolio SSE backpressure limit must be in 2..=1000.");
  }

  router.get("/api/portfolio/events", dependencies.authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = requestedAccount(request);
    if (!accountId || accountId.length > 128) {
      response.status(400).json({
        error: { code: "invalid-account", message: "조회할 계좌를 선택해 주세요." },
      });
      return;
    }
    if (!dependencies.live) {
      response.setHeader("Retry-After", "5");
      response.status(503).json({
        error: {
          code: "portfolio-events-unavailable",
          message: "포트폴리오 실시간 이벤트 스트림을 사용할 수 없습니다.",
          retryable: true,
        },
      });
      return;
    }

    const lastEventId = requestedRevision(request);
    let lastSent = lastEventId ?? 0;
    let ended = false;
    let blocked = false;
    let replaying = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let untrack: () => void = () => undefined;
    let subscription: PortfolioLiveSubscription;
    const pending: PortfolioEventV1[] = [];
    const queuedDuringReplay: PortfolioEventV1[] = [];

    const cleanup = () => {
      if (ended) return;
      ended = true;
      if (heartbeat) clearInterval(heartbeat);
      request.off("close", cleanup);
      response.off("close", cleanup);
      response.off("drain", drain);
      subscription.release();
      const unregister = untrack;
      untrack = () => undefined;
      unregister();
    };

    const closeForBackpressure = () => {
      if (!response.writableEnded && !response.destroyed) response.end();
      cleanup();
    };

    const send = (event: PortfolioEventV1) => {
      if (ended || event.revision <= lastSent) return;
      if (blocked) {
        if (pending.length >= backpressureEventLimit - 1) {
          closeForBackpressure();
          return;
        }
        pending.push(event);
        return;
      }
      blocked = !writePortfolioEvent(response, event);
      lastSent = event.revision;
    };

    const sendLive = (event: PortfolioEventV1) => {
      if (replaying) queuedDuringReplay.push(event);
      else send(event);
    };

    const drain = () => {
      blocked = false;
      while (!blocked && pending.length) send(pending.shift()!);
    };

    try {
      subscription = dependencies.live.subscribe(ownerSubject, accountId, sendLive);
    } catch (error) {
      if (error instanceof PortfolioLiveBusyError) {
        response.setHeader("Retry-After", "5");
        response.status(503).json({
          error: {
            code: error.code,
            message: "포트폴리오 실시간 연결이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
            retryable: error.retryable,
          },
        });
        return;
      }
      sendPortfolioError(response, error, logError);
      return;
    }

    try {
      await subscription.ready;
    } catch (error) {
      subscription.release();
      sendPortfolioError(response, error, logError);
      return;
    }
    if (request.destroyed || response.destroyed) {
      subscription.release();
      return;
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

    const snapshot = dependencies.live.snapshotAfter(ownerSubject, accountId, lastEventId);
    if (snapshot) {
      if (lastEventId !== undefined && lastEventId > snapshot.revision) lastSent = 0;
      send(snapshot);
    }
    replaying = false;
    for (const event of queuedDuringReplay.sort(
      (left, right) => left.revision - right.revision,
    )) {
      send(event);
    }

    if (ended) return;
    heartbeat = setInterval(() => {
      if (ended || blocked || lastSent < 1) return;
      const event: PortfolioEventV1 = {
        schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
        accountId,
        revision: lastSent,
        type: "heartbeat",
        emittedAt: new Date().toISOString(),
        payload: null,
      };
      blocked = !writePortfolioEvent(response, event);
    }, heartbeatMs);
    heartbeat.unref();
  });

  router.get("/api/portfolio", dependencies.authenticate, async (request, response) => {
    setNoStore(response);
    try {
      const account = typeof request.query.account === "string" ? request.query.account : undefined;
      const force = request.query.refresh === "1";
      const portfolio = await dependencies.getPortfolio(account, force);
      if (request.query.snapshot !== "0") {
        try {
          await dependencies.recordPortfolio(portfolio);
        } catch (historyError) {
          logError("history", historyError);
        }
      }
      response.json(portfolio);
    } catch (error) {
      sendPortfolioError(response, error, logError);
    }
  });

  return router;
}
