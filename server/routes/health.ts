import { Router } from "express";
import type { ComputeExecutionMode, McpAuthMode } from "../env.js";

export type HealthRouteDependencies = {
  storageBackend: string;
  reportStorageBackend: string;
  reportGenerationConfigured: boolean;
  exchangeRateFallback: "kis" | "disabled";
  kisEnvironment?: string;
  mcpEnabled: boolean;
  mcpAuthMode: McpAuthMode;
  buildInfo: () => unknown;
  executionMode: ComputeExecutionMode;
  rustSocketPath: string;
  eventLoopLagSnapshot: () => unknown;
  simulationEnabled: boolean;
};

export function createHealthRouter(dependencies: HealthRouteDependencies): Router {
  const router = Router();
  router.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "portfolio-lens",
      storage: dependencies.storageBackend,
      reportStorage: dependencies.reportStorageBackend,
      reportGeneration: dependencies.reportGenerationConfigured ? "configured" : "unconfigured",
      marketData: {
        exchangeRateFallback: dependencies.exchangeRateFallback,
        kisEnvironment: dependencies.kisEnvironment,
      },
      mcp: dependencies.mcpEnabled ? "enabled" : "disabled",
      mcpAuth: !dependencies.mcpEnabled
        ? "disabled"
        : dependencies.mcpAuthMode === "oauth" ? "oauth" : "local-none",
      build: dependencies.buildInfo(),
      compute: {
        executionMode: dependencies.executionMode,
        rustSocket: dependencies.executionMode === "rust_socket"
          ? dependencies.rustSocketPath
          : undefined,
        eventLoopLagMs: dependencies.eventLoopLagSnapshot(),
      },
      simulation: {
        enabled: dependencies.simulationEnabled,
        realOrder: false,
        mcp: false,
      },
    });
  });
  return router;
}
