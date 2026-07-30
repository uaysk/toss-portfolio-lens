import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  PortfolioQueryController,
  portfolioQueryActivity,
  type PortfolioQueryError,
  type PortfolioQueryPhase,
} from "@/lib/portfolio-query-controller";
import {
  PORTFOLIO_FALLBACK_INITIAL_MS,
  nextPortfolioFallbackDelay,
  shouldRefreshPortfolioInBackground,
} from "@/lib/portfolio-refresh";
import {
  parsePortfolioEventMessage,
  portfolioEventsUrl,
} from "@/lib/portfolio-events";
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

export function usePortfolioQuery(
  onUnauthorized: () => void,
  liveUpdatesEnabled = true,
): PortfolioQuery {
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
    if (!accountId || !liveUpdatesEnabled) return;

    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    let fallbackDelayMs = PORTFOLIO_FALLBACK_INITIAL_MS;

    const closeSource = () => {
      source?.close();
      source = undefined;
    };
    const clearRetry = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const openStream = () => {
      if (stopped
        || source
        || !shouldRefreshPortfolioInBackground(document.visibilityState)) {
        return;
      }
      if (typeof EventSource === "undefined") {
        scheduleFallback();
        return;
      }
      const nextSource = new EventSource(
        portfolioEventsUrl(accountId, controller.streamRevision(accountId)),
      );
      source = nextSource;
      nextSource.onopen = () => {
        fallbackDelayMs = PORTFOLIO_FALLBACK_INITIAL_MS;
        clearRetry();
      };
      const receive = (message: MessageEvent<string>) => {
        const event = parsePortfolioEventMessage(message.data);
        if (!event || event.accountId !== accountId) return;
        controller.applyPortfolioEvent(event);
        fallbackDelayMs = PORTFOLIO_FALLBACK_INITIAL_MS;
      };
      nextSource.addEventListener("snapshot", receive as EventListener);
      nextSource.addEventListener("changed", receive as EventListener);
      nextSource.addEventListener("heartbeat", receive as EventListener);
      nextSource.onerror = () => {
        if (source !== nextSource) return;
        closeSource();
        scheduleFallback();
      };
    };

    const scheduleFallback = () => {
      if (stopped
        || retryTimer !== undefined
        || !shouldRefreshPortfolioInBackground(document.visibilityState)) {
        return;
      }
      const waitMs = fallbackDelayMs;
      fallbackDelayMs = nextPortfolioFallbackDelay(fallbackDelayMs);
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (stopped || !shouldRefreshPortfolioInBackground(document.visibilityState)) return;
        void controller.refreshInBackground(accountId).finally(() => {
          if (!stopped) openStream();
        });
      }, waitMs);
    };

    const onVisibilityChange = () => {
      if (!shouldRefreshPortfolioInBackground(document.visibilityState)) {
        closeSource();
        clearRetry();
        return;
      }
      fallbackDelayMs = PORTFOLIO_FALLBACK_INITIAL_MS;
      openStream();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    openStream();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      closeSource();
      clearRetry();
    };
  }, [controller, liveUpdatesEnabled, state.portfolio?.selectedAccountId]);

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
