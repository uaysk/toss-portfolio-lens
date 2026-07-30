import type { Portfolio } from "@/types";

export const PORTFOLIO_EVENT_SCHEMA_VERSION = 1 as const;

export type PortfolioEventV1 = {
  schemaVersion: typeof PORTFOLIO_EVENT_SCHEMA_VERSION;
  accountId: string;
  revision: number;
  emittedAt: string;
  type: "snapshot" | "changed" | "heartbeat";
  payload: Portfolio | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPortfolio(value: unknown): value is Portfolio {
  if (!isRecord(value)) return false;
  return typeof value.asOf === "string"
    && Array.isArray(value.accounts)
    && typeof value.selectedAccountId === "string"
    && isRecord(value.account)
    && isRecord(value.summary)
    && Array.isArray(value.holdings);
}

export function parsePortfolioEvent(value: unknown): PortfolioEventV1 | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== PORTFOLIO_EVENT_SCHEMA_VERSION
    || typeof value.accountId !== "string"
    || value.accountId.length < 1
    || value.accountId.length > 128
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || typeof value.emittedAt !== "string"
    || Number.isNaN(Date.parse(value.emittedAt))
    || !["snapshot", "changed", "heartbeat"].includes(String(value.type))) {
    return undefined;
  }
  const type = value.type as PortfolioEventV1["type"];
  if (type === "heartbeat") {
    if (value.payload !== null) return undefined;
  } else if (!isPortfolio(value.payload) || value.payload.selectedAccountId !== value.accountId) {
    return undefined;
  }
  return value as PortfolioEventV1;
}

export function parsePortfolioEventMessage(data: string): PortfolioEventV1 | undefined {
  try {
    return parsePortfolioEvent(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function portfolioEventsUrl(accountId: string, lastEventId?: number): string {
  const params = new URLSearchParams({ account: accountId });
  if (Number.isSafeInteger(lastEventId) && Number(lastEventId) > 0) {
    params.set("lastEventId", String(lastEventId));
  }
  return `/api/portfolio/events?${params.toString()}`;
}
