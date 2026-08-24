import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const importEffects = vi.hoisted(() => ({
  applicationRuntimeModuleLoaded: vi.fn(),
  applicationRuntimeStart: vi.fn(),
}));

vi.mock("./application-runtime.js", () => {
  importEffects.applicationRuntimeModuleLoaded();
  return {
    ApplicationRuntime: {
      start: importEffects.applicationRuntimeStart,
    },
  };
});

describe("server bootstrap boundary", () => {
  it("imports without starting storage, monitors, timers, listeners, or runtime assembly", async () => {
    vi.useFakeTimers();
    const signalListeners = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const timers = vi.getTimerCount();

    try {
      const module = await import("./bootstrap.js");

      expect(module.bootstrap).toBeTypeOf("function");
      expect(importEffects.applicationRuntimeModuleLoaded).not.toHaveBeenCalled();
      expect(importEffects.applicationRuntimeStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timers);
      expect(process.listenerCount("SIGINT")).toBe(signalListeners.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(signalListeners.sigterm);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("loads and starts the application runtime only when bootstrap is called", async () => {
    const { bootstrap } = await import("./bootstrap.js");
    const config = {} as Parameters<typeof bootstrap>[0];

    await bootstrap(config);

    expect(importEffects.applicationRuntimeModuleLoaded).toHaveBeenCalledTimes(1);
    expect(importEffects.applicationRuntimeStart).toHaveBeenCalledTimes(1);
    expect(importEffects.applicationRuntimeStart).toHaveBeenCalledWith(config);
  });

  it("keeps the executable entrypoint limited to config loading and bootstrap", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('import { bootstrap } from "./bootstrap.js"');
    expect(source).toContain("const config = loadConfig()");
    expect(source).toContain("await bootstrap(config)");
    expect(source).not.toMatch(/createServer|\.listen\(|setInterval|setTimeout|process\.on/);
  });

  it("loads the Bedrock SDK only inside the configured provider branch", () => {
    const source = readFileSync(new URL("./application-runtime.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/import\s+\{[^}]*BedrockReportWriter[^}]*\}\s+from/u);
    expect(source).toContain('config.bedrock\n  ? new (await import("./bedrock-report-ai.js"))');
  });

  it("loads optional MCP and stock-scalping runtimes only inside their enabled branches", () => {
    const source = readFileSync(new URL("./application-runtime.ts", import.meta.url), "utf8");
    const importHeader = source.slice(0, source.indexOf("export class ApplicationRuntime"));
    const scalpingBranch = source.slice(
      source.indexOf("if (config.scalping.enabled && scalpingRepository)"),
      source.indexOf("const computeToolDependencies"),
    );
    const mcpBranch = source.slice(
      source.indexOf("if (config.mcp.enabled)"),
      source.indexOf("const __dirname"),
    );
    const scalpingModules = [
      "./services/scalping-ai-service.js",
      "./scalping/toss-provider.js",
      "./scalping/kis-rest-client.js",
      "./scalping/kis-websocket-client.js",
      "./scalping/intraday-bar-aggregator.js",
      "./scalping/scanner-service.js",
      "./scalping/live-runtime.js",
      "./scalping/market-data-recorder.js",
      "./scalping/scalping-service.js",
      "./simulation/simulation-service.js",
      "./scalping/market-session.js",
    ] as const;
    const mcpModules = [
      "./auth/mcp-oauth-routes.js",
      "./mcp/server.js",
      "./mcp/transport.js",
    ] as const;

    for (const modulePath of [...scalpingModules, ...mcpModules]) {
      const headerReferences = importHeader
        .split("\n")
        .filter((line) => line.includes(`from "${modulePath}"`));
      expect(headerReferences.every((line) => line.trimStart().startsWith("import type ")))
        .toBe(true);
    }
    for (const modulePath of scalpingModules) {
      expect(scalpingBranch).toContain(`import("${modulePath}")`);
    }
    for (const modulePath of mcpModules) {
      expect(mcpBranch).toContain(`import("${modulePath}")`);
    }

    const scalpingRouterSource = readFileSync(
      new URL("./scalping/router.ts", import.meta.url),
      "utf8",
    );
    expect(scalpingRouterSource).toContain("MARKET_DATA_RECORDER_SCHEMA_VERSION");
    expect(scalpingRouterSource).not.toMatch(
      /import\s+\{[^}]*MARKET_DATA_RECORDER_SCHEMA_VERSION[^}]*\}\s+from\s+"\.\/market-data-recorder\.js"/u,
    );
  });

  it("keeps enabled optional runtimes connected to their routers and shutdown lifecycle", () => {
    const source = readFileSync(new URL("./application-runtime.ts", import.meta.url), "utf8");

    for (const statement of [
      "mcpOAuthRuntime = await createMcpOAuthRuntime({",
      "mcpHttpRuntime = createMcpHttpRuntime({",
      "if (mcpOAuthRuntime) application.use(mcpOAuthRuntime.router)",
      "if (mcpHttpRuntime) application.use(mcpHttpRuntime.router)",
      'shutdownStep("MCP transport", () => mcpHttpRuntime?.close())',
      "scalpingLiveRuntime = new ScalpingLiveRuntime(",
      "scalpingService = new ScalpingService(",
      "marketDataRecorder = new MarketDataRecorder(",
      "simulationService = new AiTradingSimulationService(",
      "service: scalpingService",
      "live: scalpingLiveRuntime",
      "recorder: marketDataRecorder",
      "await marketDataRecorder.start()",
      "await marketDataRecorder?.close()",
      "scalpingLiveRuntime?.close()",
      "await scalpingLiveRuntime?.waitForIdle()",
      'shutdownStep("AI client", () => aiComputeClient?.close())',
    ]) {
      expect(source).toContain(statement);
    }
  });

  it("owns startup resources until the graceful lifecycle is installed", () => {
    const source = readFileSync(new URL("./application-runtime.ts", import.meta.url), "utf8");
    const position = (marker: string) => {
      const index = source.indexOf(marker);
      expect(index, `missing startup ownership marker: ${marker}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const ordered = (...markers: string[]) => {
      const positions = markers.map(position);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    };

    for (const cleanup of [
      "event loop lag monitor",
      "portfolio live hub",
      "history storage",
      "historical backfill",
      "Rust client",
      "MCP audit cleanup",
      "run service",
      "FinCast AI client",
      "Chronos-2 AI client",
      "crypto simulation",
      "scalping runtime",
      "stock AI client",
      "market-data recorder",
      "stock simulation",
      "MCP OAuth cleanup",
      "MCP transport",
      "snapshot collection",
      "lifecycle listeners",
    ]) {
      expect(source).toMatch(new RegExp(`startupRollback\\.defer\\(\\s*"${cleanup}"`, "u"));
    }

    ordered(
      "const startupRollback = new StartupRollback()",
      "await ApplicationRuntime.startManaged(config, startupRollback)",
      "return startupRollback.rethrow(error)",
    );
    ordered(
      'startupRollback.defer("event loop lag monitor"',
      "eventLoopLag.start()",
      "await openConfiguredHistoryStore(config)",
      'startupRollback.defer("history storage"',
      "await initializeCorePersistence({",
    );
    ordered(
      'startupRollback.defer("run service"',
      "await new BinanceSignedReadProbe({",
      'startupRollback.defer("FinCast AI client"',
      "cryptoFincastClient.start()",
    );
    ordered(
      "scalpingLiveRuntime = new ScalpingLiveRuntime(",
      'startupRollback.defer("scalping runtime"',
      "aiComputeClient = new AiComputeClient({",
      'startupRollback.defer("stock AI client"',
      "const stockFincastAi = new ScalpingAiService(",
    );
    ordered(
      "mcpOAuthRuntime = await createMcpOAuthRuntime({",
      'startupRollback.defer("MCP OAuth cleanup"',
      "mcpCleanupTimer = setInterval(",
    );
    ordered(
      "mcpHttpRuntime = createMcpHttpRuntime({",
      'startupRollback.defer("MCP transport"',
      "const __dirname",
    );
    ordered(
      'startupRollback.defer("snapshot collection"',
      "snapshotOrchestrator.start()",
      "const lifecycle = new GracefulLifecycle({",
      'startupRollback.defer("lifecycle listeners"',
      "lifecycle.installSignalHandlers()",
      "await marketDataRecorder.start()",
      "await listenForStartup(server, config.port, config.host)",
    );
    expect(source.lastIndexOf("startupRollback.commit()"))
      .toBeGreaterThan(position("await listenForStartup(server, config.port, config.host)"));
    expect(source).toContain(
      'startupRollback.commit();\n    await lifecycle.shutdown("recorder-start-failed")',
    );
  });
});
