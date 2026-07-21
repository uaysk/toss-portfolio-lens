import type { PortfolioRunKind, PortfolioRunRecord } from "../repositories/run-repository.js";

/**
 * Scalping runs are intentionally dashboard-only. Keeping this deny-list at the
 * MCP boundary prevents generic run and resource endpoints from becoming an
 * accidental second API for intraday predictions.
 */
export const MCP_VISIBLE_RUN_KINDS = [
  "backtest",
  "optimization",
  "walk_forward",
  "stress_test",
  "weight_sensitivity",
  "start_date_sensitivity",
  "rebalance_sensitivity",
  "cash_flow_sensitivity",
  "monte_carlo",
  "outlook",
  "technical_analysis",
  "technical_strategy",
  "exposure_analysis",
  "pareto_frontier",
  "research_report",
] as const satisfies readonly PortfolioRunKind[];

const visibleKinds = new Set<PortfolioRunKind>(MCP_VISIBLE_RUN_KINDS);

export function isMcpVisibleRunKind(kind: PortfolioRunKind): boolean {
  return visibleKinds.has(kind);
}

export function mcpVisibleRun<T extends Pick<PortfolioRunRecord, "kind">>(run: T | undefined): T | undefined {
  return run && isMcpVisibleRunKind(run.kind) ? run : undefined;
}
