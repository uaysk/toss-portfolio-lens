import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dashboardAnalysisOperations } from "./dashboard-analysis.js";
import { toolSchemas, type ToolName } from "./mcp/schemas.js";
import { toolMetadata } from "./mcp/tools/metadata.js";

const bootstrapSource = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
const dashboardRouteSource = readFileSync(
  new URL("./routes/dashboard-tools.ts", import.meta.url),
  "utf8",
);
const advancedClientSource = readFileSync(new URL("../src/lib/advanced-analysis.ts", import.meta.url), "utf8");
const libraryClientSource = readFileSync(new URL("../src/lib/research-library.ts", import.meta.url), "utf8");
const libraryUiSource = readFileSync(new URL("../src/components/research-library.tsx", import.meta.url), "utf8");
const resultUiSource = readFileSync(new URL("../src/components/portfolio-research-results.tsx", import.meta.url), "utf8");
const generatedContract = JSON.parse(readFileSync(
  new URL("./mcp/generated-contract.json", import.meta.url),
  "utf8",
)) as { toolCount: number; tools: Array<{ name: string }> };

type ManagementFeature = {
  tool: ToolName;
  method: "get" | "post" | "patch" | "delete";
  route: string;
  clients: string[];
};

const managementFeatures: ManagementFeature[] = [
  { tool: "list_runs", method: "get", route: "/api/portfolio/runs", clients: ["listLibraryRuns"] },
  { tool: "update_run", method: "patch", route: "/api/portfolio/runs/:runId", clients: ["updateLibraryRun"] },
  { tool: "delete_run", method: "delete", route: "/api/portfolio/runs/:runId", clients: ["deleteLibraryRun"] },
  { tool: "duplicate_run", method: "post", route: "/api/portfolio/runs/:runId/duplicate", clients: ["runLibraryAction"] },
  { tool: "rerun_run", method: "post", route: "/api/portfolio/runs/:runId/rerun", clients: ["runLibraryAction"] },
  { tool: "get_run_events", method: "get", route: "/api/portfolio/runs/:runId/events", clients: ["getLibraryRunEvents"] },
  { tool: "export_run_manifest", method: "get", route: "/api/portfolio/runs/:runId/manifest", clients: ["getLibraryRunManifest"] },
  { tool: "list_portfolio_presets", method: "get", route: "/api/portfolio/presets", clients: ["listLibraryPresets"] },
  { tool: "get_portfolio_preset", method: "get", route: "/api/portfolio/presets/:presetId", clients: ["getLibraryPreset"] },
  { tool: "get_portfolio_preset", method: "get", route: "/api/portfolio/presets/:presetId/history", clients: ["getLibraryPresetHistory"] },
  { tool: "create_portfolio_preset", method: "post", route: "/api/portfolio/presets", clients: ["createLibraryPreset"] },
  { tool: "update_portfolio_preset", method: "patch", route: "/api/portfolio/presets/:presetId", clients: ["updateLibraryPreset"] },
  { tool: "duplicate_portfolio_preset", method: "post", route: "/api/portfolio/presets/:presetId/duplicate", clients: ["duplicateLibraryPreset"] },
  { tool: "delete_portfolio_preset", method: "delete", route: "/api/portfolio/presets/:presetId", clients: ["deleteLibraryPreset"] },
  { tool: "import_portfolio_presets", method: "post", route: "/api/portfolio/presets/import", clients: ["importLibraryPreset"] },
  { tool: "export_portfolio_preset", method: "get", route: "/api/portfolio/presets/:presetId/export", clients: ["exportLibraryPreset"] },
];

function exportedFunction(source: string, name: string): boolean {
  return source.includes(`export async function ${name}(`) || source.includes(`export function ${name}(`);
}

function sourceCall(source: string, receiver: string, argument: string): boolean {
  const escapedReceiver = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedArgument = argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escapedReceiver}\\(\\s*"${escapedArgument}"`).test(source);
}

describe("UI / HTTP API / MCP feature parity", () => {
  it("generated MCP inventory, Zod schemas and metadata are exact", () => {
    const expected = generatedContract.tools.map((tool) => tool.name);
    expect(generatedContract.toolCount).toBe(expected.length);
    expect(Object.keys(toolSchemas)).toEqual(expected);
    expect(Object.keys(toolMetadata)).toEqual(expected);
  });

  it("every MCP tool is reachable through the schema-validated generic HTTP API", () => {
    expect(bootstrapSource).toContain("createDashboardToolsRouter({");
    expect(bootstrapSource).toContain("(application) => application.use(dashboardToolsRouter)");
    expect(dashboardRouteSource).toContain('router.post("/api/portfolio/tools/:toolName"');
    expect(dashboardRouteSource).toContain("toolSchemas[name].parse(input)");
    expect(dashboardRouteSource).toContain("managementHandlers[name](parsed, ownerSubject)");
  });

  it("advanced UI operations exactly match the HTTP dispatcher and MCP tool schemas", () => {
    const union = advancedClientSource.match(/export type AdvancedAnalysisOperation\s*=([\s\S]*?);/);
    expect(union, "AdvancedAnalysisOperation union was not found").not.toBeNull();
    const uiOperations = Array.from(union![1].matchAll(/"([a-z][a-z-]+)"/g), (match) => match[1]);
    expect(uiOperations).toEqual(Object.keys(dashboardAnalysisOperations));
    expect(dashboardRouteSource).toContain('router.post("/api/portfolio/advanced/:operation"');
    for (const tool of Object.values(dashboardAnalysisOperations)) {
      expect(toolSchemas[tool], `${tool} Zod schema`).toBeDefined();
      expect(toolMetadata[tool], `${tool} MCP metadata`).toBeDefined();
    }
  });

  it("run and preset management keep dedicated HTTP routes, UI clients and MCP handlers aligned", () => {
    for (const feature of managementFeatures) {
      expect(toolSchemas[feature.tool], `${feature.tool} Zod schema`).toBeDefined();
      expect(toolMetadata[feature.tool], `${feature.tool} MCP metadata`).toBeDefined();
      expect(
        sourceCall(dashboardRouteSource, `router.${feature.method}`, feature.route),
        `${feature.method.toUpperCase()} ${feature.route}`,
      ).toBe(true);
      expect(
        sourceCall(dashboardRouteSource, "executeDashboardManagement", feature.tool),
        `${feature.tool} dedicated handler`,
      ).toBe(true);
      for (const client of feature.clients) {
        expect(exportedFunction(libraryClientSource, client), `${client} UI client`).toBe(true);
      }
    }
  });

  it("async lifecycle and lazy artifacts exist in both MCP and dashboard UI contracts", () => {
    for (const tool of ["get_run_status", "cancel_run", "get_run_result", "get_run_artifact"] as const) {
      expect(toolSchemas[tool]).toBeDefined();
      expect(toolMetadata[tool]).toBeDefined();
    }
    expect(dashboardRouteSource).toContain('router.get("/api/portfolio/advanced/runs/:runId"');
    expect(dashboardRouteSource).toContain('"/api/portfolio/advanced/runs/:runId/result"');
    expect(dashboardRouteSource).toContain('"/api/portfolio/advanced/runs/:runId/cancel"');
    expect(dashboardRouteSource).toContain('"/api/portfolio/advanced/runs/:runId/artifacts/:type"');
    for (const client of ["runAdvancedAnalysis", "loadAdvancedRunSnapshot", "cancelAdvancedAnalysis", "loadAdvancedArtifact"]) {
      expect(exportedFunction(advancedClientSource, client), `${client} UI client`).toBe(true);
    }
    for (const tool of ["analyze_portfolio_exposures", "build_pareto_frontier", "generate_research_report"] as const) {
      expect(toolSchemas[tool].safeParse({
        ...(tool === "analyze_portfolio_exposures"
          ? { assets: [{ symbol: "AAA", weight: 1, currency: "USD" }] }
          : { runId: "11111111-1111-4111-8111-111111111111", ...(tool === "build_pareto_frontier" ? {} : { format: "json" }) }),
        executionMode: "async",
      }).success, `${tool} async schema`).toBe(true);
    }
    expect(advancedClientSource).toContain('run.kind === "exposure_analysis"');
    expect(advancedClientSource).toContain('run.kind === "pareto_frontier"');
    expect(advancedClientSource).toContain('run.kind === "research_report"');
  });

  it("research report generation is available from MCP and the run library UI", () => {
    expect(toolSchemas.generate_research_report).toBeDefined();
    expect(toolMetadata.generate_research_report).toBeDefined();
    expect(exportedFunction(libraryClientSource, "generateLibraryResearchReport")).toBe(true);
    expect(libraryUiSource).toContain("generateLibraryResearchReport(runId");
  });

  it("all supported preset snapshot sources are schema-valid and exposed by the UI", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const sources = [
      { type: "manual" },
      { type: "current_portfolio", holdings: [{ symbol: "AAA" }] },
      { type: "run", runId },
      { type: "optimization_candidate", runId, candidateIndex: 0 },
      { type: "pareto_candidate", runId, candidateIndex: 0 },
    ];
    for (const source of sources) {
      expect(toolSchemas.create_portfolio_preset.safeParse({ name: source.type, source }).success, source.type).toBe(true);
    }
    expect(libraryUiSource).toContain('source: { type: "run", runId: run.id }');
    expect(libraryUiSource).toContain("getLibraryPresetHistory");
    expect(resultUiSource).toContain('type: "optimization_candidate"');
    expect(resultUiSource).toContain('type: "pareto_candidate"');
  });

  it("preset execution inputs and Outlook validation artifacts have UI/MCP parity", () => {
    const presetId = "11111111-1111-4111-8111-111111111111";
    for (const tool of ["run_portfolio_backtest", "optimize_portfolio", "walk_forward_optimize"] as const) {
      expect(toolSchemas[tool].safeParse({ presetId }).success, tool).toBe(true);
      expect(toolMetadata[tool]).toBeDefined();
      expect(libraryUiSource).toContain(`executePreset(preset, "${tool}")`);
    }
    expect(exportedFunction(libraryClientSource, "executeLibraryPreset")).toBe(true);
    expect(resultUiSource).toContain('type: "outlook-market-regimes"');
    expect(resultUiSource).toContain('type: "outlook-calibration"');
  });
});
