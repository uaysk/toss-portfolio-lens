import type { Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { RequestHandler } from "express";

type LifecycleLogger = Pick<Console, "info" | "warn" | "error">;

export class ShutdownGate {
  private shuttingDown = false;

  readonly middleware: RequestHandler = (_request, response, next) => {
    if (!this.shuttingDown) {
      next();
      return;
    }
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Connection", "close");
    response.status(503).json({
      error: {
        code: "server-shutting-down",
        message: "서버가 종료 중입니다. 잠시 후 다시 시도해 주세요.",
      },
    });
  };

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  get active(): boolean {
    return this.shuttingDown;
  }
}

type TrackedSseResponse = Pick<
  ServerResponse,
  "destroyed" | "end" | "off" | "once" | "writableEnded"
>;

type SseEntry = {
  close: () => void;
};

export class SseConnectionTracker {
  private readonly entries = new Set<SseEntry>();
  private closing = false;

  constructor(private readonly logger: LifecycleLogger = console) {}

  track(response: TrackedSseResponse, cleanup: () => void): () => void {
    let active = true;
    const onClose = () => unregister();
    const unregister = () => {
      if (!active) return;
      active = false;
      response.off("close", onClose);
      this.entries.delete(entry);
    };
    const entry: SseEntry = {
      close: () => {
        if (!active) return;
        unregister();
        try {
          cleanup();
        } catch (error) {
          this.logger.warn(
            "[shutdown] SSE cleanup failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        } finally {
          if (!response.writableEnded && !response.destroyed) {
            try {
              response.end();
            } catch (error) {
              this.logger.warn(
                "[shutdown] SSE response close failed:",
                error instanceof Error ? error.message : "unknown error",
              );
            }
          }
        }
      },
    };

    if (this.closing || response.writableEnded || response.destroyed) {
      entry.close();
      return () => undefined;
    }
    this.entries.add(entry);
    response.once("close", onClose);
    return unregister;
  }

  closeAll(): void {
    this.closing = true;
    for (const entry of [...this.entries]) entry.close();
  }

  get size(): number {
    return this.entries.size;
  }
}

export type GracefulLifecycleOptions = {
  server: Server;
  gate: ShutdownGate;
  sseConnections: SseConnectionTracker;
  deadlineMs: number;
  onShutdownStart?: (reason: string) => void | Promise<void>;
  onDrained?: (reason: string) => void | Promise<void>;
  onStopped?: (reason: string, forced: boolean) => void | Promise<void>;
  exit?: (code: number) => void;
  logger?: LifecycleLogger;
};

export class GracefulLifecycle {
  private readonly sockets = new Set<Socket>();
  private readonly logger: LifecycleLogger;
  private shutdownTask?: Promise<void>;
  private signalHandlersInstalled = false;

  private readonly onConnection = (socket: Socket) => {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  };

  private readonly onSigterm = () => {
    void this.shutdown("SIGTERM");
  };

  private readonly onSigint = () => {
    void this.shutdown("SIGINT");
  };

  constructor(private readonly options: GracefulLifecycleOptions) {
    if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1) {
      throw new Error("Graceful shutdown deadline must be a positive integer.");
    }
    this.logger = options.logger ?? console;
    options.server.on("connection", this.onConnection);
  }

  installSignalHandlers(): () => void {
    if (!this.signalHandlersInstalled) {
      process.on("SIGTERM", this.onSigterm);
      process.on("SIGINT", this.onSigint);
      this.signalHandlersInstalled = true;
    }
    return () => this.removeSignalHandlers();
  }

  shutdown(reason: string): Promise<void> {
    if (!this.shutdownTask) this.shutdownTask = this.performShutdown(reason);
    return this.shutdownTask;
  }

  private async performShutdown(reason: string): Promise<void> {
    const startedAt = Date.now();
    this.options.gate.beginShutdown();
    this.options.sseConnections.closeAll();

    let start: Promise<void>;
    try {
      start = Promise.resolve(this.options.onShutdownStart?.(reason));
    } catch (error) {
      start = Promise.reject(error);
    }
    let shutdownStartSettled = false;
    start = start.finally(() => {
      shutdownStartSettled = true;
    });
    const http = this.closeHttpServer();
    const drain = Promise.allSettled([http, start]).then(([httpResult, startResult]) => {
      if (httpResult.status === "rejected") {
        this.logger.error(
          "[shutdown] HTTP close failed:",
          httpResult.reason instanceof Error ? httpResult.reason.message : "unknown error",
        );
      }
      if (startResult.status === "rejected") {
        this.logger.error(
          "[shutdown] drain failed:",
          startResult.reason instanceof Error ? startResult.reason.message : "unknown error",
        );
      }
    });

    const finalizationReserveMs = Math.max(
      1,
      Math.min(1_000, Math.floor(this.options.deadlineMs / 5)),
    );
    const drainBudgetMs = Math.max(1, this.options.deadlineMs - finalizationReserveMs);
    let drainTimer: NodeJS.Timeout | undefined;
    const drainOutcome = await Promise.race([
      drain.then(() => "drained" as const),
      new Promise<"deadline">((resolve) => {
        drainTimer = setTimeout(() => resolve("deadline"), drainBudgetMs);
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);

    const forced = drainOutcome === "deadline";
    if (forced) {
      this.logger.warn(
        `[shutdown] graceful drain budget exceeded; closing remaining connections before the ${this.options.deadlineMs}ms deadline.`,
      );
      this.options.sseConnections.closeAll();
      this.options.server.closeAllConnections?.();
      for (const socket of this.sockets) socket.destroy();
    }

    this.options.server.off("connection", this.onConnection);
    this.removeSignalHandlers();
    const finalization = (async () => {
      if (shutdownStartSettled) {
        try {
          await this.options.onDrained?.(reason);
        } catch (error) {
          this.logger.error(
            "[shutdown] final close failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      } else {
        this.logger.warn(
          "[shutdown] application drain did not finish before the deadline; skipping final resource close.",
        );
      }
      try {
        await this.options.onStopped?.(reason, forced);
      } catch (error) {
        this.logger.error(
          "[shutdown] stop callback failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      }
    })();
    const remainingMs = Math.max(1, this.options.deadlineMs - (Date.now() - startedAt));
    let finalizationTimer: NodeJS.Timeout | undefined;
    const finalizationOutcome = await Promise.race([
      finalization.then(() => "finalized" as const),
      new Promise<"deadline">((resolve) => {
        finalizationTimer = setTimeout(() => resolve("deadline"), remainingMs);
      }),
    ]);
    if (finalizationTimer) clearTimeout(finalizationTimer);
    if (finalizationOutcome === "deadline") {
      this.logger.warn(
        `[shutdown] ${this.options.deadlineMs}ms deadline exceeded; final cleanup did not complete.`,
      );
    }
    this.options.exit?.(0);
  }

  private closeHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.options.server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
        this.options.server.closeIdleConnections?.();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }
    });
  }

  private removeSignalHandlers(): void {
    if (!this.signalHandlersInstalled) return;
    process.off("SIGTERM", this.onSigterm);
    process.off("SIGINT", this.onSigint);
    this.signalHandlersInstalled = false;
  }
}
