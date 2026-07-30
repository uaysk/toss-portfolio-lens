import { CHART_UPDATE_INTERVAL_MS } from "@/lib/chart-update";

export const PORTFOLIO_REFRESH_INTERVAL_MS = CHART_UPDATE_INTERVAL_MS;
export const PORTFOLIO_FALLBACK_INITIAL_MS = 5_000;
export const PORTFOLIO_FALLBACK_MAX_MS = 30_000;

export function shouldRefreshPortfolioInBackground(
  visibilityState: DocumentVisibilityState,
): boolean {
  return visibilityState === "visible";
}

export function portfolioRequestUrl(account?: string, force = false, recordSnapshot = true): string {
  const params = new URLSearchParams();
  if (account) params.set("account", account);
  if (force) params.set("refresh", "1");
  if (!recordSnapshot) params.set("snapshot", "0");
  return "/api/portfolio" + (params.size ? `?${params.toString()}` : "");
}

export function nextPortfolioFallbackDelay(currentMs: number): number {
  return Math.min(
    PORTFOLIO_FALLBACK_MAX_MS,
    Math.max(PORTFOLIO_FALLBACK_INITIAL_MS, currentMs * 2),
  );
}
