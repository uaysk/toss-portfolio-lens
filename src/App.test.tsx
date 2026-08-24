import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionUnavailable } from "@/App";
import {
  checkAuthSession,
  reduceAuthenticationState,
  type AuthenticationState,
} from "@/lib/auth-session";

type TestFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type HostElementProps = {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  tabIndex?: number;
  type?: string;
};

function findHostElement(
  node: ReactNode,
  type: string,
): ReactElement<HostElementProps> | undefined {
  if (!isValidElement<HostElementProps>(node)) return undefined;
  if (node.type === type) return node;
  for (const child of Children.toArray(node.props.children)) {
    const match = findHostElement(child, type);
    if (match) return match;
  }
  return undefined;
}

async function unavailableState(fetcher: TestFetcher): Promise<AuthenticationState> {
  const event = await checkAuthSession(undefined, fetcher);
  return reduceAuthenticationState("checking", event);
}

function unavailableMarkup(): string {
  return renderToStaticMarkup(
    <SessionUnavailable
      theme="dark"
      onToggleTheme={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

describe("App authentication failure UX", () => {
  it("maps an HTTP 503 session check to the unavailable alert", async () => {
    const state = await unavailableState(async () => new Response("unavailable", { status: 503 }));

    expect(state).toBe("unavailable");
    const markup = unavailableMarkup();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("서버에 연결할 수 없습니다");
    expect(markup).toContain("로그인 상태를 확인하지 못했습니다");
  });

  it("maps a network failure to the same unavailable alert", async () => {
    const state = await unavailableState(async () => {
      throw new TypeError("network connection failed");
    });

    expect(state).toBe("unavailable");
    expect(unavailableMarkup()).toContain('role="alert"');
  });

  it("uses a keyboard-accessible retry button and transitions to authenticated after retry", async () => {
    let state: AuthenticationState = "unavailable";
    const onRetry = vi.fn(() => {
      state = reduceAuthenticationState(state, { type: "retry" });
    });
    const view = SessionUnavailable({
      theme: "dark",
      onToggleTheme: () => undefined,
      onRetry,
    });
    const retryButton = findHostElement(view, "button");

    expect(retryButton).toBeDefined();
    expect(retryButton?.props.type).toBe("button");
    expect(retryButton?.props.disabled).not.toBe(true);
    expect(retryButton?.props.tabIndex).not.toBe(-1);
    expect(retryButton?.props.className).toContain("focus-visible:ring-2");
    expect(renderToStaticMarkup(view)).toContain("다시 시도");

    retryButton?.props.onClick?.();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(state).toBe("checking");

    const successfulCheck = await checkAuthSession(undefined, async () => new Response(
      JSON.stringify({ authenticated: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    state = reduceAuthenticationState(state, successfulCheck);
    expect(state).toBe("authenticated");
  });
});
