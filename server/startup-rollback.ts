import type { Server } from "node:http";

type StartupRollbackLogger = Pick<Console, "warn">;

type StartupCleanup = {
  name: string;
  operation: () => void | Promise<void>;
};

/**
 * Owns resources only while the application is being assembled. Once the
 * runtime has bound its HTTP listener (or graceful shutdown begins), commit()
 * transfers that ownership to the normal shutdown path.
 */
export class StartupRollback {
  private readonly cleanups: StartupCleanup[] = [];
  private state: "active" | "committed" | "rolled-back" = "active";

  constructor(private readonly logger: StartupRollbackLogger = console) {}

  defer(name: string, operation: StartupCleanup["operation"]): void {
    if (this.state !== "active") {
      throw new Error("Startup rollback is no longer accepting cleanup operations.");
    }
    this.cleanups.push({ name, operation });
  }

  commit(): void {
    if (this.state !== "active") return;
    this.state = "committed";
    this.cleanups.length = 0;
  }

  async rollback(): Promise<void> {
    if (this.state !== "active") return;
    this.state = "rolled-back";
    const cleanups = this.cleanups.splice(0).reverse();
    for (const cleanup of cleanups) {
      try {
        await cleanup.operation();
      } catch (error) {
        try {
          this.logger.warn(
            `[startup] rollback ${cleanup.name} failed:`,
            error instanceof Error ? error.message : "unknown error",
          );
        } catch {
          // A logger failure must not hide the original startup error or skip
          // the remaining cleanup operations.
        }
      }
    }
  }

  async rethrow(error: unknown): Promise<never> {
    await this.rollback();
    throw error;
  }
}

/** Waits for the actual bind result so asynchronous listen errors stay in startup. */
export function listenForStartup(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onListening = () => settle(resolve);

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
