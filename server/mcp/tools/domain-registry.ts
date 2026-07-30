import { toolSchemas, type ToolName } from "../schemas.js";

export const MCP_TOOL_DOMAINS = {
  market: [
    "search_instruments",
    "get_data_availability",
    "get_price_series",
    "get_current_portfolio",
    "explain_data_quality",
  ],
  technical: [
    "analyze_technical_signals",
    "validate_technical_strategy",
    "run_technical_strategy_backtest",
    "analyze_instrument",
    "analyze_asset_relationship",
    "get_correlation_matrix",
    "find_diversifying_assets",
    "analyze_market_regimes",
    "find_redundant_assets",
    "analyze_rebalance_plan",
    "analyze_portfolio_exposures",
  ],
  simulation: [
    "validate_backtest_config",
    "run_portfolio_backtest",
    "compare_backtests",
    "get_backtest_artifact",
    "get_run_artifact",
    "analyze_return_contribution",
    "optimize_portfolio",
    "walk_forward_optimize",
    "stress_test_portfolio",
    "build_pareto_frontier",
    "analyze_weight_sensitivity",
    "analyze_start_date_sensitivity",
    "analyze_rebalance_sensitivity",
    "analyze_cash_flow_sensitivity",
    "simulate_portfolio_monte_carlo",
    "analyze_portfolio_outlook",
  ],
  runs: [
    "get_run_status",
    "cancel_run",
    "get_run_result",
    "list_runs",
    "get_run_events",
    "export_run_manifest",
    "update_run",
    "duplicate_run",
    "delete_run",
    "rerun_run",
  ],
  presets: [
    "list_portfolio_presets",
    "get_portfolio_preset",
    "create_portfolio_preset",
    "update_portfolio_preset",
    "duplicate_portfolio_preset",
    "delete_portfolio_preset",
    "import_portfolio_presets",
    "export_portfolio_preset",
  ],
  reports: [
    "generate_backtest_report",
    "generate_research_report",
    "get_report",
  ],
} as const satisfies Record<string, readonly ToolName[]>;

export type McpToolDomain = keyof typeof MCP_TOOL_DOMAINS;

export type McpDomainRegistry<THandler> = {
  handlers: Record<ToolName, THandler>;
  domains: Readonly<Record<McpToolDomain, Readonly<Partial<Record<ToolName, THandler>>>>>;
};

export function createMcpDomainRegistry<THandler>(
  handlers: Record<ToolName, THandler>,
): McpDomainRegistry<THandler> {
  const expected = Object.keys(toolSchemas) as ToolName[];
  const assigned = Object.values(MCP_TOOL_DOMAINS).flat();
  const assignedSet = new Set<ToolName>();
  for (const name of assigned) {
    if (assignedSet.has(name)) {
      throw new Error(`MCP tool domain registry contains duplicate tool: ${name}`);
    }
    assignedSet.add(name);
  }
  const missing = expected.filter((name) => !assignedSet.has(name));
  const unknown = assigned.filter((name) => !(name in toolSchemas));
  if (missing.length || unknown.length || assigned.length !== expected.length) {
    throw new Error(
      `MCP tool domain registry coverage mismatch; missing=${missing.join(",")} unknown=${unknown.join(",")}`,
    );
  }

  const domains = Object.fromEntries(
    Object.entries(MCP_TOOL_DOMAINS).map(([domain, names]) => [
      domain,
      Object.freeze(Object.fromEntries(
        names.map((name) => [name, handlers[name]]),
      )),
    ]),
  ) as McpDomainRegistry<THandler>["domains"];
  return {
    handlers,
    domains: Object.freeze(domains),
  };
}
