import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolSchemas } from "./mcp/schemas.js";
import { toolMetadata } from "./mcp/tools/metadata.js";

const serverSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("technical analysis server wiring", () => {
  it("공통 HTTP/MCP tool registry와 실제 TechnicalAnalysisService assembly를 연결한다", () => {
    expect(toolSchemas.analyze_technical_signals).toBeDefined();
    expect(toolMetadata.analyze_technical_signals).toMatchObject({ scopes: ["market:read"] });
    expect(serverSource).toContain("new TechnicalAnalysisService(marketData, runService, artifactService, rustCompute)");
    expect(serverSource).toContain("technicalAnalysis: technicalAnalysisService");
    expect(serverSource).toContain('app.post("/api/portfolio/tools/:toolName"');
  });

  it("typed 기술 신호 검증·백테스트 tool을 같은 TechnicalStrategyService assembly에 연결한다", () => {
    expect(toolSchemas.validate_technical_strategy).toBeDefined();
    expect(toolSchemas.run_technical_strategy_backtest).toBeDefined();
    expect(toolMetadata.validate_technical_strategy).toMatchObject({ scopes: ["backtest:run"] });
    expect(toolMetadata.run_technical_strategy_backtest).toMatchObject({ scopes: ["backtest:run"] });
    expect(serverSource).toContain("new TechnicalStrategyService(");
    expect(serverSource).toContain("technicalStrategies: technicalStrategyService");
  });

  it("거래 marker 조회를 세션 인증 GET endpoint에 조립한다", () => {
    expect(serverSource).toContain("new TechnicalTradeMarkerService(historyStore, portfolioAnalysis)");
    expect(serverSource).toContain('app.get("/api/portfolio/technical/trades", requireSession');
    expect(serverSource).toContain("technicalTradeMarkerService.getMarkers");
    expect(serverSource).toContain("sendDashboardAnalysisError(response, error)");
  });
});
