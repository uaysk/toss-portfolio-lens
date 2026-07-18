export type DashboardView = "overview" | "analysis" | "backtest" | "optimization";

const hashes: Record<DashboardView, string> = {
  overview: "#overview",
  analysis: "#analysis",
  backtest: "#backtest",
  optimization: "#optimization",
};

export function dashboardViewFromHash(hash: string): DashboardView {
  const entry = Object.entries(hashes).find(([, value]) => value === hash);
  return (entry?.[0] as DashboardView | undefined) ?? "overview";
}

export function dashboardHash(view: DashboardView): string {
  return hashes[view];
}
