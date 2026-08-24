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
  appReplicaCount: 1;
  buildInfo: () => unknown;
  executionMode: ComputeExecutionMode;
  rustSocketPath: string;
  rustSchedulerSnapshot: () => unknown;
  eventLoopLagSnapshot: () => unknown;
  sseConnectionSnapshot?: () => unknown;
  simulationSseSnapshot?: () => unknown;
  portfolioLiveSnapshot?: () => unknown;
  runtimeTelemetrySnapshot?: () => unknown;
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
      topology: {
        web: {
          replicaPolicy: "single",
          declaredReplicas: dependencies.appReplicaCount,
          coordinationScope: "process",
          horizontalScalingSupported: false,
        },
      },
      build: dependencies.buildInfo(),
      runtime: dependencies.runtimeTelemetrySnapshot?.(),
      sseConnections: dependencies.sseConnectionSnapshot?.(),
      compute: {
        executionMode: dependencies.executionMode,
        rustSocket: dependencies.executionMode === "rust_socket"
          ? dependencies.rustSocketPath
          : undefined,
        scheduler: dependencies.executionMode === "rust_socket"
          ? dependencies.rustSchedulerSnapshot()
          : undefined,
        eventLoopLagMs: dependencies.eventLoopLagSnapshot(),
      },
      simulation: {
        enabled: dependencies.simulationEnabled,
        realOrder: false,
        mcp: false,
        sse: dependencies.simulationSseSnapshot?.(),
      },
      portfolio: {
        live: dependencies.portfolioLiveSnapshot?.(),
      },
    });
  });
  return router;
}
