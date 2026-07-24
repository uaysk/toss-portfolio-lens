import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  PortfolioQueryController,
  portfolioQueryActivity,
  type PortfolioQueryError,
  type PortfolioQueryPhase,
} from "@/lib/portfolio-query-controller";
import {
  PORTFOLIO_REFRESH_INTERVAL_MS,
  shouldRefreshPortfolioInBackground,
} from "@/lib/portfolio-refresh";
import type { Portfolio } from "@/types";

export type PortfolioQuery = {
  portfolio?: Portfolio;
  error?: PortfolioQueryError;
  phase: PortfolioQueryPhase;
  loading: boolean;
  refreshing: boolean;
  switchingAccount: boolean;
  backgroundRefreshing: boolean;
  retryInitial: () => Promise<void>;
  changeAccount: (accountId: string) => Promise<void>;
  refresh: (accountId: string) => Promise<void>;
};

export function usePortfolioQuery(onUnauthorized: () => void): PortfolioQuery {
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const controllerRef = useRef<PortfolioQueryController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new PortfolioQueryController({
      onUnauthorized: () => onUnauthorizedRef.current(),
    });
  }
  const controller = controllerRef.current;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.activate();
    void controller.loadInitial();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const accountId = state.portfolio?.selectedAccountId;
    if (!accountId) return;
    const interval = window.setInterval(() => {
      if (shouldRefreshPortfolioInBackground(document.visibilityState)) {
        void controller.refreshInBackground(accountId);
      }
    }, PORTFOLIO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [controller, state.portfolio?.selectedAccountId]);

  const retryInitial = useCallback(
    () => controller.loadInitial(),
    [controller],
  );
  const changeAccount = useCallback(
    (accountId: string) => controller.changeAccount(accountId),
    [controller],
  );
  const refresh = useCallback(
    (accountId: string) => controller.refresh(accountId),
    [controller],
  );
  const activity = portfolioQueryActivity(state);

  return {
    portfolio: state.portfolio,
    error: state.error,
    phase: state.phase,
    ...activity,
    retryInitial,
    changeAccount,
    refresh,
  };
}
