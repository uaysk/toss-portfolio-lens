import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolSchemas } from "./mcp/schemas.js";
import { toolMetadata } from "./mcp/tools/metadata.js";

const bootstrapSource = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
const dashboardRouteSource = readFileSync(
  new URL("./routes/dashboard-tools.ts", import.meta.url),
  "utf8",
);

describe("technical analysis server wiring", () => {
  it("공통 HTTP/MCP tool registry와 실제 TechnicalAnalysisService assembly를 연결한다", () => {
    expect(toolSchemas.analyze_technical_signals).toBeDefined();
    expect(toolMetadata.analyze_technical_signals).toMatchObject({ scopes: ["market:read"] });
    expect(bootstrapSource).toContain("new TechnicalAnalysisService(marketData, runService, artifactService, rustCompute)");
    expect(bootstrapSource).toContain("technicalAnalysis: technicalAnalysisService");
    expect(bootstrapSource).toContain("createDashboardToolsRouter({");
    expect(dashboardRouteSource).toContain('router.post("/api/portfolio/tools/:toolName"');
  });

  it("typed 기술 신호 검증·백테스트 tool을 같은 TechnicalStrategyService assembly에 연결한다", () => {
    expect(toolSchemas.validate_technical_strategy).toBeDefined();
    expect(toolSchemas.run_technical_strategy_backtest).toBeDefined();
    expect(toolMetadata.validate_technical_strategy).toMatchObject({ scopes: ["backtest:run"] });
    expect(toolMetadata.run_technical_strategy_backtest).toMatchObject({ scopes: ["backtest:run"] });
    expect(bootstrapSource).toContain("new TechnicalStrategyService(");
    expect(bootstrapSource).toContain("technicalStrategies: technicalStrategyService");
  });

  it("거래 marker 조회를 세션 인증 GET endpoint에 조립한다", () => {
    expect(bootstrapSource).toContain("new TechnicalTradeMarkerService(historyStore, portfolioAnalysis)");
    expect(bootstrapSource).toContain("technicalTradeMarkerService,");
    expect(dashboardRouteSource).toContain('router.get("/api/portfolio/technical/trades", authenticate');
    expect(dashboardRouteSource).toContain("technicalTradeMarkerService.getMarkers");
    expect(dashboardRouteSource).toContain("sendDashboardAnalysisError(response, error)");
  });
});
