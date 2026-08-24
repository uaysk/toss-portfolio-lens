type SessionFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_SESSION_CHECK_TIMEOUT_MS = 10_000;
let authenticationSessionEpoch = 0;

export function currentAuthenticationSessionEpoch(): number {
  return authenticationSessionEpoch;
}

export function invalidateAuthenticationSessionMemory(): void {
  authenticationSessionEpoch += 1;
}

export type AuthenticationState = "checking" | "authenticated" | "unauthenticated" | "unavailable";

export type AuthenticationEvent =
  | { type: "session-resolved"; authenticated: boolean }
  | { type: "session-unavailable" }
  | { type: "retry" }
  | { type: "signed-in" }
  | { type: "signed-out" };

export function reduceAuthenticationState(
  state: AuthenticationState,
  event: AuthenticationEvent,
): AuthenticationState {
  switch (event.type) {
    case "session-resolved": {
      if (state !== "checking") return state;
      return event.authenticated ? "authenticated" : "unauthenticated";
    }
    case "session-unavailable":
      return state === "checking" ? "unavailable" : state;
    case "retry":
      return state === "unavailable" ? "checking" : state;
    case "signed-in":
      return "authenticated";
    case "signed-out":
      return "unauthenticated";
  }
}

export async function loadAuthSession(
  signal?: AbortSignal,
  fetcher: SessionFetcher = fetch,
  timeoutMs = DEFAULT_SESSION_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("session check timeout must be a positive integer");
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher("/api/auth/session", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`session check failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (
      !payload
      || typeof payload !== "object"
      || !("authenticated" in payload)
      || typeof (payload as { authenticated?: unknown }).authenticated !== "boolean"
    ) {
      throw new Error("session check returned an invalid response");
    }
    return (payload as { authenticated: boolean }).authenticated;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function checkAuthSession(
  signal?: AbortSignal,
  fetcher: SessionFetcher = fetch,
  timeoutMs = DEFAULT_SESSION_CHECK_TIMEOUT_MS,
): Promise<AuthenticationEvent> {
  try {
    return {
      type: "session-resolved",
      authenticated: await loadAuthSession(signal, fetcher, timeoutMs),
    };
  } catch {
    return { type: "session-unavailable" };
  }
}
