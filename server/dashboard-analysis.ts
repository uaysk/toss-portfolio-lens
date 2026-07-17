import { z } from "zod";
import { toolSchemas, type ToolName } from "./mcp/schemas.js";
import { createToolHandlers, type McpToolDependencies } from "./mcp/tools/handlers.js";
import { ServiceError } from "./services/service-envelope.js";
import { enforceToolRequestLimits } from "./services/tool-request-limits.js";
import { BacktestValidationError } from "./backtest-engine.js";
import { TossApiError } from "./toss.js";

export const dashboardAnalysisOperations = {
  optimization: "optimize_portfolio",
  "walk-forward": "walk_forward_optimize",
  "stress-test": "stress_test_portfolio",
  "sensitivity-weight": "analyze_weight_sensitivity",
  "sensitivity-start-date": "analyze_start_date_sensitivity",
  "sensitivity-rebalance": "analyze_rebalance_sensitivity",
  "sensitivity-cash-flow": "analyze_cash_flow_sensitivity",
  "monte-carlo": "simulate_portfolio_monte_carlo",
  "compare-backtests": "compare_backtests",
  "diversifying-assets": "find_diversifying_assets",
  "market-regimes": "analyze_market_regimes",
  "return-contribution": "analyze_return_contribution",
  "pareto-frontier": "build_pareto_frontier",
  "redundant-assets": "find_redundant_assets",
  "rebalance-plan": "analyze_rebalance_plan",
} as const satisfies Record<string, ToolName>;

export type DashboardAnalysisOperation = keyof typeof dashboardAnalysisOperations;

export function isDashboardAnalysisOperation(value: string): value is DashboardAnalysisOperation {
  return Object.hasOwn(dashboardAnalysisOperations, value);
}

export function createDashboardAnalysisExecutor(dependencies: McpToolDependencies) {
  const handlers = createToolHandlers(dependencies);
  return async (operation: string, input: unknown, ownerSubject: string): Promise<unknown> => {
    if (!isDashboardAnalysisOperation(operation)) {
      throw new ServiceError({
        code: "DASHBOARD_OPERATION_NOT_FOUND",
        message: "지원하지 않는 고급 분석 작업입니다.",
        retryable: false,
      });
    }
    const toolName = dashboardAnalysisOperations[operation];
    const parsed = toolSchemas[toolName].parse(input);
    enforceToolRequestLimits(parsed, dependencies);
    return handlers[toolName](parsed, ownerSubject);
  };
}

const runIdSchema = z.string().uuid();

export function parseDashboardRunId(value: unknown): string {
  return runIdSchema.parse(value);
}

export function dashboardAnalysisError(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; retryable?: boolean; field?: string; issues?: Array<{ path: string; message: string }> } };
} {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid-analysis-request",
          message: error.issues[0]?.message ?? "고급 분석 입력값을 확인해 주세요.",
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof ServiceError) {
    const status = error.detail.code === "RUN_NOT_FOUND" || error.detail.code === "DASHBOARD_OPERATION_NOT_FOUND"
      ? 404
      : error.detail.code === "RUN_ALREADY_ACTIVE"
        ? 409
        : error.detail.code.includes("QUEUE") || error.detail.code.includes("CONCURRENT")
          ? 429
          : error.detail.code.includes("RUST_COMPUTE")
            ? 503
            : error.detail.retryable ? 503 : 422;
    return {
      status,
      body: {
        error: {
          code: error.detail.code,
          message: error.detail.message,
          retryable: error.detail.retryable,
          ...(error.detail.field ? { field: error.detail.field } : {}),
        },
      },
    };
  }
  if (error instanceof BacktestValidationError) {
    return {
      status: 400,
      body: { error: { code: "invalid-backtest", message: error.message } },
    };
  }
  if (error instanceof TossApiError) {
    return {
      status: error.status === 404 || error.status === 429 ? error.status : 502,
      body: { error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "analysis-unavailable", message: "고급 분석을 처리하지 못했습니다." } },
  };
}
