import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { setNoStore } from "../auth.js";
import type { SseConnectionTracker } from "../lifecycle.js";
import {
  MarketCountrySchema,
  MinuteIntervalSchema,
  UsExchangeSchema,
  type MarketCountry,
  type UsExchange,
} from "./contracts.js";
import type { ScalpingLiveEvent, ScalpingLiveRuntime } from "./live-runtime.js";
import {
  ValidationError,
  mapScalpingError,
} from "./domain-errors.js";
import type {
  ScalpingRealtimeAnalysisRequest,
  ScalpingService,
} from "./scalping-service.js";

export type ScalpingRouterConfig = {
  enabled: boolean;
  maximumSymbols: number;
  heartbeatMs: number;
  analysisDebounceMs: number;
  backpressureEventLimit: number;
};

export type ScalpingRouterDependencies = {
  authenticate: RequestHandler;
  service?: Pick<ScalpingService, "status" | "workspace" | "forecast" | "evaluate" | "realtimeAnalysis">;
  live?: Pick<ScalpingLiveRuntime, "retain" | "onEvent" | "eventsAfter" | "waitForIdle">;
  sseConnections?: Pick<SseConnectionTracker, "track">;
  config: ScalpingRouterConfig;
};

const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const StreamPresetSchema = z.enum(["trend", "breakout", "mean_reversion", "risk_management"]);

export type StreamAnalysisOptions = Pick<ScalpingRealtimeAnalysisRequest, "interval" | "preset" | "accountId"> & {
  marketCountry: MarketCountry;
};

export function parseStreamSymbols(value: unknown, maximum: number): string[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 50) throw new Error("maximum symbols is invalid");
  const raw = typeof value === "string" ? value.split(",") : [];
  const symbols = Array.from(new Set(raw.map((item) => item.trim().toUpperCase()).filter(Boolean)));
  if (!symbols.length || symbols.length > maximum || symbols.some((symbol) => !SYMBOL.test(symbol))) {
    throw new ValidationError(`symbols must contain 1..${maximum} valid symbols`);
  }
  return symbols;
}

export function parseStreamAnalysisOptions(query: Record<string, unknown>): StreamAnalysisOptions {
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    interval: MinuteIntervalSchema,
    preset: StreamPresetSchema,
    accountId: z.string().trim().min(1).max(128).optional(),
  }).strict().parse({
    marketCountry: typeof query.marketCountry === "string" ? query.marketCountry : undefined,
    interval: typeof query.interval === "string" ? query.interval : undefined,
    preset: typeof query.preset === "string" ? query.preset : undefined,
    ...(typeof query.accountId === "string" ? { accountId: query.accountId } : {}),
  });
}

export function parseStreamExchanges(
  value: unknown,
  symbols: readonly string[],
  marketCountry: MarketCountry,
): Readonly<Record<string, UsExchange>> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (marketCountry === "KR") {
    if (raw) throw new ValidationError("exchanges are only valid for US symbols");
    return {};
  }
  const requested = new Set(symbols);
  const output: Record<string, UsExchange> = {};
  for (const entry of raw ? raw.split(",") : []) {
    const [rawSymbol, rawExchange, extra] = entry.split(":");
    const symbol = rawSymbol?.trim().toUpperCase() ?? "";
    if (!symbol || extra !== undefined || !requested.has(symbol)) {
      throw new ValidationError("exchanges must only contain requested US symbols");
    }
    const exchange = UsExchangeSchema.parse(rawExchange?.trim().toUpperCase());
    if (output[symbol] && output[symbol] !== exchange) {
      throw new ValidationError(`conflicting exchange for ${symbol}`);
    }
    output[symbol] = exchange;
  }
  return output;
}

function barInterval(event: ScalpingLiveEvent): number | undefined {
  if (event.type !== "bar" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const value = (event.payload as Record<string, unknown>).intervalMinutes;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isFinalBar(event: ScalpingLiveEvent): boolean {
  return event.type === "bar"
    && event.payload !== null
    && typeof event.payload === "object"
    && !Array.isArray(event.payload)
    && (event.payload as Record<string, unknown>).state === "final";
}

function lastEventId(request: Request): number | undefined {
  const raw = request.get("last-event-id") ?? (typeof request.query.lastEventId === "string" ? request.query.lastEventId : undefined);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function writeSse(response: Response, event: ScalpingLiveEvent): boolean {
  return response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    schemaVersion: event.schemaVersion,
    id: event.id,
    emittedAt: event.emittedAt,
    type: event.type,
    symbol: event.symbol,
    marketCountry: event.marketCountry,
    data: event.payload,
  })}\n\n`);
}

function writeAnalysisSse(response: Response, data: unknown): boolean {
  return response.write(`event: analysis\ndata: ${JSON.stringify({ type: "analysis", data })}\n\n`);
}

function unavailable(response: Response): void {
  setNoStore(response);
  response.status(503).json({
    error: {
      code: "scalping-disabled",
      message: "단타 보조 기능이 설정되지 않았습니다.",
    },
  });
}

function sendError(response: Response, error: unknown): void {
  setNoStore(response);
  const mapped = mapScalpingError(error);
  for (const [name, value] of Object.entries(mapped.headers ?? {})) {
    response.setHeader(name, value);
  }
  response.status(mapped.status).json(mapped.body);
}

export function createScalpingRouter(dependencies: ScalpingRouterDependencies) {
  if (!Number.isInteger(dependencies.config.heartbeatMs) || dependencies.config.heartbeatMs < 1_000) {
    throw new Error("scalping SSE heartbeat must be at least 1000ms");
  }
  if (!Number.isInteger(dependencies.config.analysisDebounceMs)
    || dependencies.config.analysisDebounceMs < 50
    || dependencies.config.analysisDebounceMs > 5_000) {
    throw new Error("scalping realtime analysis debounce must be in 50..=5000ms");
  }
  const router = express.Router();
  router.use(dependencies.authenticate);

  router.get("/status", (_request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) {
      response.json({
        enabled: false,
        capabilities: { autoOrder: false, mcp: false, historicalOrderbook: false },
        limitations: ["환경설정에서 단타 보조 기능이 비활성화되어 있습니다."],
      });
      return;
    }
    response.json(dependencies.service.status(true));
  });

  router.post("/workspace", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return unavailable(response);
    try {
      response.json(await dependencies.service.workspace(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/forecast", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return unavailable(response);
    try {
      response.json(await dependencies.service.forecast(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/evaluations", async (request, response) => {
    setNoStore(response);
    if (!dependencies.config.enabled || !dependencies.service) return unavailable(response);
    try {
      response.status(202).json(await dependencies.service.evaluate(request.body, "owner"));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/stream", async (request, response) => {
    if (!dependencies.config.enabled || !dependencies.live || !dependencies.service) return unavailable(response);
    let symbols: string[];
    let analysisOptions: StreamAnalysisOptions;
    let exchanges: Readonly<Record<string, UsExchange>>;
    try {
      symbols = parseStreamSymbols(request.query.symbols, dependencies.config.maximumSymbols);
      analysisOptions = parseStreamAnalysisOptions(request.query as Record<string, unknown>);
      exchanges = parseStreamExchanges(request.query.exchanges, symbols, analysisOptions.marketCountry);
    } catch (error) {
      return sendError(response, error);
    }
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    let ended = false;
    const resumeAfter = lastEventId(request);
    let lastSent = resumeAfter ?? 0;
    const pendingEvents: ScalpingLiveEvent[] = [];
    let pendingAnalysis: unknown;
    let blocked = false;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    let analysisRunning = false;
    let analysisQueued = false;
    const analysisAbort = new AbortController();
    const requested = new Set(symbols);
    const requestedInterval = Number.parseInt(analysisOptions.interval, 10);

    const scheduleAnalysis = () => {
      if (ended) return;
      analysisQueued = true;
      if (analysisRunning) return;
      if (analysisTimer) clearTimeout(analysisTimer);
      analysisTimer = setTimeout(() => {
        analysisTimer = undefined;
        if (ended || analysisRunning || !analysisQueued) return;
        analysisQueued = false;
        analysisRunning = true;
        void (async () => {
          try {
            await dependencies.live!.waitForIdle();
            const result = await dependencies.service!.realtimeAnalysis(
              { symbols, ...analysisOptions },
              { signal: analysisAbort.signal },
            );
            if (ended) return;
            if (blocked) pendingAnalysis = result;
            else blocked = !writeAnalysisSse(response, result);
          } catch {
            const result = {
              schemaVersion: "scalping-realtime-analysis/v1",
              interval: analysisOptions.interval,
              preset: analysisOptions.preset,
              technical: { status: "unavailable", reason: "realtime_analysis_failed" },
            };
            if (!ended) {
              if (blocked) pendingAnalysis = result;
              else blocked = !writeAnalysisSse(response, result);
            }
          } finally {
            analysisRunning = false;
            if (analysisQueued && !ended) scheduleAnalysis();
          }
        })();
      }, dependencies.config.analysisDebounceMs);
      analysisTimer.unref();
    };

    let removeListener: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let release: (() => void) | undefined;
    let untrack: () => void = () => undefined;
    const runCleanup = (name: string, operation: (() => void) | undefined) => {
      if (!operation) return;
      try {
        operation();
      } catch (error) {
        console.warn(
          `[scalping] SSE ${name} cleanup failed:`,
          error instanceof Error ? error.message : "unknown error",
        );
      }
    };
    const cleanup = () => {
      if (ended) return;
      ended = true;
      if (heartbeat) clearInterval(heartbeat);
      if (analysisTimer) clearTimeout(analysisTimer);
      if (!analysisAbort.signal.aborted) analysisAbort.abort();
      response.off("drain", drain);
      const removeEventListener = removeListener;
      removeListener = undefined;
      const releaseSubscription = release;
      release = undefined;
      const unregisterConnection = untrack;
      untrack = () => undefined;
      runCleanup("listener", removeEventListener);
      runCleanup("subscription", releaseSubscription);
      runCleanup("tracker", unregisterConnection);
    };
    const writeLiveEvent = (event: ScalpingLiveEvent) => {
      if (ended || event.id <= lastSent) return;
      if (blocked) {
        // The same configured limit bounds both the runtime replay ring and this
        // connection-local FIFO. Close before it can outrun the replay ring so
        // EventSource can resume from the last event that was actually written.
        if (pendingEvents.length >= Math.max(1, dependencies.config.backpressureEventLimit - 1)) {
          response.end();
          cleanup();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      blocked = !writeSse(response, event);
      lastSent = event.id;
    };

    const send = (event: ScalpingLiveEvent) => {
      if (ended || event.id <= lastSent
        || (event.marketCountry !== undefined && event.marketCountry !== analysisOptions.marketCountry)
        || (event.symbol && !requested.has(event.symbol))) return;
      const interval = barInterval(event);
      if (event.type === "bar" && interval !== requestedInterval) return;
      if (interval === requestedInterval && isFinalBar(event)) scheduleAnalysis();
      writeLiveEvent(event);
    };
    let replaying = resumeAfter !== undefined;
    const queuedDuringReplay: ScalpingLiveEvent[] = [];
    const sendLive = (event: ScalpingLiveEvent) => {
      if (replaying) queuedDuringReplay.push(event);
      else send(event);
    };
    const drain = () => {
      blocked = false;
      while (!blocked && pendingEvents.length) writeLiveEvent(pendingEvents.shift()!);
      if (!blocked && pendingAnalysis !== undefined) {
        const analysis = pendingAnalysis;
        pendingAnalysis = undefined;
        blocked = !writeAnalysisSse(response, analysis);
      }
    };
    response.on("drain", drain);
    request.on("close", cleanup);
    response.on("close", cleanup);
    removeListener = dependencies.live.onEvent(sendLive);
    untrack = dependencies.sseConnections?.track(response, cleanup) ?? (() => undefined);
    if (resumeAfter !== undefined) {
      for (const event of dependencies.live.eventsAfter(resumeAfter).sort((left, right) => left.id - right.id)) send(event);
      replaying = false;
      for (const event of queuedDuringReplay.sort((left, right) => left.id - right.id)) send(event);
      queuedDuringReplay.length = 0;
    }
    if (ended) return;
    heartbeat = setInterval(() => {
      if (!ended && !blocked) blocked = !response.write(`: heartbeat ${Date.now()}\n\n`);
    }, dependencies.config.heartbeatMs);
    heartbeat.unref();
    try {
      release = await dependencies.live.retain(symbols, analysisOptions.marketCountry, exchanges);
      if (ended) {
        const releaseAfterClose = release;
        release = undefined;
        runCleanup("late subscription", releaseAfterClose);
      }
    } catch {
      if (!ended) {
        response.write("event: unavailable\ndata: {\"type\":\"unavailable\",\"data\":{\"code\":\"live-provider-unavailable\"}}\n\n");
        cleanup();
        response.end();
      }
    }
  });

  router.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (!response.headersSent) sendError(response, new Error("scalping router error"));
  });
  return router;
}
