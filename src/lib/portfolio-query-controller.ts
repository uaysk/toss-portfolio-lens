import { portfolioRequestUrl } from "@/lib/portfolio-refresh";
import type { ApiError, Portfolio } from "@/types";

export type PortfolioQueryKind = "initial" | "account-change" | "manual-refresh" | "background";
export type PortfolioQueryPhase = "idle" | PortfolioQueryKind;

export type PortfolioQueryError = {
  message: string;
  requestId?: string;
};

export type PortfolioQueryState = {
  portfolio?: Portfolio;
  phase: PortfolioQueryPhase;
  error?: PortfolioQueryError;
};

export type PortfolioQueryActivity = {
  loading: boolean;
  refreshing: boolean;
  switchingAccount: boolean;
  backgroundRefreshing: boolean;
};

export function portfolioQueryActivity(state: PortfolioQueryState): PortfolioQueryActivity {
  return {
    loading: !state.portfolio && state.phase !== "idle",
    refreshing: state.phase === "manual-refresh",
    switchingAccount: state.phase === "account-change",
    backgroundRefreshing: state.phase === "background",
  };
}

export type PortfolioQueryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type PortfolioQueryControllerOptions = {
  fetcher?: PortfolioQueryFetch;
  onUnauthorized: () => void;
};

type ActiveRequest = {
  id: number;
  kind: PortfolioQueryKind;
  controller: AbortController;
};

type PortfolioPayload = Portfolio & ApiError;

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return error.name === "AbortError";
}

async function readPayload(response: Response): Promise<PortfolioPayload> {
  return await response.json().catch(() => ({})) as PortfolioPayload;
}

function responseError(payload: PortfolioPayload): PortfolioQueryError {
  return {
    message: payload.error?.message || "포트폴리오를 불러오지 못했습니다.",
    ...(payload.error?.requestId ? { requestId: payload.error.requestId } : {}),
  };
}

export class PortfolioQueryController {
  private readonly fetcher: PortfolioQueryFetch;
  private readonly onUnauthorized: () => void;
  private readonly listeners = new Set<() => void>();
  private state: PortfolioQueryState = { phase: "idle" };
  private foreground?: ActiveRequest;
  private background?: ActiveRequest;
  private nextRequestId = 0;
  private disposed = false;

  constructor(options: PortfolioQueryControllerOptions) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.onUnauthorized = options.onUnauthorized;
  }

  readonly getSnapshot = (): PortfolioQueryState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(): void {
    this.disposed = false;
  }

  loadInitial(): Promise<void> {
    return this.startForeground("initial");
  }

  changeAccount(accountId: string): Promise<void> {
    return this.startForeground("account-change", accountId);
  }

  refresh(accountId: string): Promise<void> {
    return this.startForeground("manual-refresh", accountId);
  }

  refreshInBackground(accountId: string): Promise<void> {
    if (this.disposed || this.foreground || this.background) return Promise.resolve();

    const request = this.createRequest("background");
    this.background = request;
    this.update({ phase: "background" });
    return this.execute(request, accountId, false, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.foreground?.controller.abort();
    this.background?.controller.abort();
    this.foreground = undefined;
    this.background = undefined;
  }

  private startForeground(
    kind: Exclude<PortfolioQueryKind, "background">,
    accountId?: string,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();

    this.foreground?.controller.abort();
    this.background?.controller.abort();
    this.background = undefined;

    const request = this.createRequest(kind);
    this.foreground = request;
    this.update({ phase: kind, error: undefined });
    return this.execute(request, accountId, kind === "manual-refresh", true);
  }

  private createRequest(kind: PortfolioQueryKind): ActiveRequest {
    return {
      id: ++this.nextRequestId,
      kind,
      controller: new AbortController(),
    };
  }

  private async execute(
    request: ActiveRequest,
    accountId: string | undefined,
    force: boolean,
    recordSnapshot: boolean,
  ): Promise<void> {
    try {
      const response = await this.fetcher(
        portfolioRequestUrl(accountId, force, recordSnapshot),
        {
          headers: { Accept: "application/json" },
          signal: request.controller.signal,
        },
      );
      const payload = await readPayload(response);
      if (!this.isCurrent(request)) return;

      if (response.status === 401 && payload.error?.code === "authentication-required") {
        this.onUnauthorized();
        return;
      }
      if (!response.ok) {
        const error = responseError(payload);
        throw Object.assign(new Error(error.message), error);
      }

      this.update({ portfolio: payload, error: undefined });
    } catch (caught) {
      if (!this.isCurrent(request) || isAbortError(caught)) return;
      if (request.kind !== "background") {
        const requestId = typeof caught === "object" && caught && "requestId" in caught
          ? String(caught.requestId || "")
          : "";
        this.update({
          error: {
            message: caught instanceof Error ? caught.message : "포트폴리오를 불러오지 못했습니다.",
            ...(requestId ? { requestId } : {}),
          },
        });
      }
    } finally {
      if (!this.isCurrent(request)) return;
      if (request.kind === "background") this.background = undefined;
      else this.foreground = undefined;
      this.update({ phase: "idle" });
    }
  }

  private isCurrent(request: ActiveRequest): boolean {
    if (this.disposed || request.controller.signal.aborted) return false;
    return request.kind === "background"
      ? this.background === request
      : this.foreground === request;
  }

  private update(patch: Partial<PortfolioQueryState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
