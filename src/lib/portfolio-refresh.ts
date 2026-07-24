export const PORTFOLIO_REFRESH_INTERVAL_MS = 5_000;

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
