import { describe, expect, it, vi } from "vitest";
import { checkAuthSession, loadAuthSession } from "./auth-session";

describe("loadAuthSession", () => {
  it.each([true, false])("returns an explicit authenticated=%s response", async (authenticated) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ authenticated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(loadAuthSession(undefined, fetcher)).resolves.toBe(authenticated);
    expect(fetcher).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({
      cache: "no-store",
      headers: { Accept: "application/json" },
    }));
  });

  it("does not misclassify an upstream failure as a signed-out session", async () => {
    const fetcher = vi.fn(async () => new Response("gateway unavailable", { status: 503 }));
    await expect(loadAuthSession(undefined, fetcher)).rejects.toThrow("HTTP 503");
  });

  it.each([
    {},
    { authenticated: "false" },
    { authenticated: 0 },
  ])("rejects malformed session payloads", async (payload) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(loadAuthSession(undefined, fetcher)).rejects.toThrow("invalid response");
  });

  it("aborts an unresponsive session check and reports it as unavailable", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request aborted", "AbortError"));
        }, { once: true });
      });
    });

    await expect(checkAuthSession(undefined, fetcher, 5)).resolves.toEqual({
      type: "session-unavailable",
    });
    expect(requestSignal?.aborted).toBe(true);
  });
});
