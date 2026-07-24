import { describe, expect, it, vi } from "vitest";
import {
  PortfolioQueryController,
  portfolioQueryActivity,
  type PortfolioQueryFetch,
} from "./portfolio-query-controller";
import type { Portfolio } from "@/types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type PendingRequest = {
  url: string;
  signal: AbortSignal;
  response: Deferred<Response>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function portfolio(accountId: string): Portfolio {
  const account = { id: accountId, name: accountId, label: accountId, type: "STOCK" };
  return {
    asOf: "2026-07-24T00:00:00.000Z",
    accounts: [account],
    selectedAccountId: accountId,
    account,
    summary: {
      evaluationAmount: { KRW: 0, USD: 0 },
      purchaseAmount: { KRW: 0, USD: 0 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 0,
    },
    holdings: [],
  };
}

function harness() {
  const requests: PendingRequest[] = [];
  const fetcher: PortfolioQueryFetch = vi.fn((input, init) => {
    const pending = deferred<Response>();
    requests.push({
      url: String(input),
      signal: init?.signal as AbortSignal,
      response: pending,
    });
    return pending.promise;
  });
  const onUnauthorized = vi.fn();
  const controller = new PortfolioQueryController({ fetcher, onUnauthorized });
  return { controller, fetcher, onUnauthorized, requests };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PortfolioQueryController", () => {
  it("느린 이전 요청이 최신 요청의 상태와 portfolio를 덮어쓰지 않는다", async () => {
    const { controller, requests } = harness();
    const first = controller.loadInitial();
    const second = controller.refresh("account-1");

    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("manual-refresh");

    requests[0].response.resolve(response(portfolio("stale")));
    await settle();
    expect(controller.getSnapshot().phase).toBe("manual-refresh");
    expect(controller.getSnapshot().portfolio).toBeUndefined();
    expect(portfolioQueryActivity(controller.getSnapshot())).toMatchObject({
      loading: true,
      refreshing: true,
    });

    requests[1].response.resolve(response(portfolio("account-1")));
    await Promise.all([first, second]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      portfolio: { selectedAccountId: "account-1" },
    });
  });

  it("계좌 전환 중 이전 계좌 응답과 stale 401을 무시한다", async () => {
    const { controller, onUnauthorized, requests } = harness();
    const first = controller.changeAccount("account-a");
    const second = controller.changeAccount("account-b");

    expect(requests[0].signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("account-change");
    expect(portfolioQueryActivity(controller.getSnapshot()).switchingAccount).toBe(true);

    requests[1].response.resolve(response(portfolio("account-b")));
    await second;
    requests[0].response.resolve(response({
      error: { code: "authentication-required", message: "로그인이 필요합니다." },
    }, 401));
    await first;

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(controller.getSnapshot().portfolio?.selectedAccountId).toBe("account-b");
  });

  it("foreground refresh 중 background tick을 시작하지 않는다", async () => {
    const { controller, fetcher, requests } = harness();
    const foreground = controller.refresh("account-1");
    const background = controller.refreshInBackground("account-1");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("manual-refresh");
    await background;

    requests[0].response.resolve(response(portfolio("account-1")));
    await foreground;
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("foreground 요청이 진행 중인 background 요청을 취소한다", async () => {
    const { controller, requests } = harness();
    const background = controller.refreshInBackground("account-1");
    const foreground = controller.refresh("account-1");

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("/api/portfolio?account=account-1&snapshot=0");
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].url).toBe("/api/portfolio?account=account-1&refresh=1");

    requests[0].response.resolve(response(portfolio("stale")));
    await settle();
    expect(controller.getSnapshot().phase).toBe("manual-refresh");

    requests[1].response.resolve(response(portfolio("account-1")));
    await Promise.all([background, foreground]);
    expect(controller.getSnapshot().portfolio?.selectedAccountId).toBe("account-1");
  });

  it("dispose 시 활성 요청을 취소하고 이후 응답을 반영하지 않는다", async () => {
    const { controller, requests } = harness();
    const listener = vi.fn();
    controller.subscribe(listener);
    const loading = controller.loadInitial();
    expect(listener).toHaveBeenCalledTimes(1);

    controller.dispose();
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].response.resolve(response(portfolio("late")));
    await loading;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().portfolio).toBeUndefined();
  });

  it("현재 401만 인증 만료로 전달하고 사용자 오류로 표시하지 않는다", async () => {
    const { controller, onUnauthorized, requests } = harness();
    const loading = controller.loadInitial();
    requests[0].response.resolve(response({
      error: {
        code: "authentication-required",
        message: "로그인이 필요합니다.",
        requestId: "auth-request",
      },
    }, 401));
    await loading;

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", error: undefined });
  });

  it("AbortError를 사용자 오류로 표시하지 않는다", async () => {
    const { controller, requests } = harness();
    const first = controller.loadInitial();
    const second = controller.refresh("account-1");
    requests[0].response.reject(new DOMException("aborted", "AbortError"));
    await first;

    expect(controller.getSnapshot()).toMatchObject({
      phase: "manual-refresh",
      error: undefined,
    });

    requests[1].response.resolve(response(portfolio("account-1")));
    await second;
  });

  it("최신 API 오류의 requestId를 유지한다", async () => {
    const { controller, requests } = harness();
    const loading = controller.refresh("account-1");
    requests[0].response.resolve(response({
      error: {
        code: "provider-unavailable",
        message: "조회 공급자를 사용할 수 없습니다.",
        requestId: "request-123",
      },
    }, 503));
    await loading;

    expect(controller.getSnapshot().error).toEqual({
      message: "조회 공급자를 사용할 수 없습니다.",
      requestId: "request-123",
    });
  });
});
