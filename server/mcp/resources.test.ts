import { describe, expect, it, vi } from "vitest";
import { McpResourceRegistry } from "./resources.js";

describe("McpResourceRegistry dashboard market resources", () => {
  it("시장 resource를 생성한 owner에게만 반환한다", () => {
    const registry = new McpResourceRegistry({} as never, {} as never, "none");
    const requestHash = "a".repeat(64);
    const descriptor = registry.storeMarket(requestHash, [{ date: "2026-01-01", value: 1 }], "revision-1", "dashboard-http");

    expect(descriptor.uri).toBe(`market://series/${requestHash}`);
    expect(registry.getMarket(requestHash, "dashboard-http")).toMatchObject({ descriptor, content: [{ date: "2026-01-01", value: 1 }] });
    expect(registry.getMarket(requestHash, "another-owner")).toBeUndefined();
  });

  it("동일 요청 hash도 owner별 resource를 독립 보관한다", () => {
    const registry = new McpResourceRegistry({} as never, {} as never, "oauth");
    const requestHash = "b".repeat(64);

    registry.storeMarket(requestHash, [{ owner: "first" }], "revision-1", "owner-a");
    registry.storeMarket(requestHash, [{ owner: "second" }], "revision-1", "owner-b");

    expect(registry.getMarket(requestHash, "owner-a")?.content).toEqual([{ owner: "first" }]);
    expect(registry.getMarket(requestHash, "owner-b")?.content).toEqual([{ owner: "second" }]);
  });

  it("공통 run artifact resource는 분석·signal-only에는 market:read, ledger run에는 backtest:run을 요구한다", async () => {
    type ResourceHandler = (
      uri: URL,
      variables: Record<string, string>,
      extra: { authInfo?: { scopes?: string[]; extra?: Record<string, unknown> } },
    ) => Promise<{ contents: Array<{ text: string }> }>;
    const handlers = new Map<string, ResourceHandler>();
    const server = {
      registerResource: vi.fn((name: string, _template: unknown, _metadata: unknown, handler: ResourceHandler) => {
        handlers.set(name, handler);
      }),
    };
    const runs = {
      get: vi.fn(async (runId: string, owner: string) => {
        if (owner !== "owner-a") return undefined;
        if (runId === "technical-run") return { id: runId, kind: "technical_analysis" };
        if (runId === "signal-run") return { id: runId, kind: "technical_strategy", input: { mode: "signal_only" } };
        if (runId === "malformed-signal-run") return {
          id: runId,
          kind: "technical_strategy",
          input: { mode: "signal_only" },
          result: { backtest: { metrics: {} } },
        };
        if (runId === "strategy-backtest-run") return { id: runId, kind: "technical_strategy", input: { mode: "backtest", backtest: {} } };
        if (runId === "backtest-run") return { id: runId, kind: "backtest" };
        return undefined;
      }),
    };
    const artifacts = {
      get: vi.fn(async (runId: string, type: string) => ({
        descriptor: { format: "application/json" },
        content: { runId, type },
      })),
    };
    const registry = new McpResourceRegistry(artifacts as never, runs as never, "oauth");
    registry.register(server as never);
    const handler = handlers.get("run-artifact");
    expect(handler).toBeDefined();
    const auth = (scopes: string[]) => ({ authInfo: { scopes, extra: { sub: "owner-a" } } });

    await expect(handler!(
      new URL("portfolio://runs/technical-run/artifacts/technical-indicators"),
      { runId: "technical-run", artifactType: "technical-indicators" },
      auth(["market:read"]),
    )).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("technical-indicators") }] });
    await expect(handler!(
      new URL("portfolio://runs/technical-run/artifacts/technical-indicators"),
      { runId: "technical-run", artifactType: "technical-indicators" },
      auth(["backtest:run"]),
    )).rejects.toThrow("market:read scope가 필요합니다.");
    await expect(handler!(
      new URL("portfolio://runs/signal-run/artifacts/technical-signals"),
      { runId: "signal-run", artifactType: "technical-signals" },
      auth(["market:read"]),
    )).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("technical-signals") }] });
    await expect(handler!(
      new URL("portfolio://runs/signal-run/artifacts/technical-signals"),
      { runId: "signal-run", artifactType: "technical-signals" },
      auth(["backtest:run"]),
    )).rejects.toThrow("market:read scope가 필요합니다.");
    await expect(handler!(
      new URL("portfolio://runs/strategy-backtest-run/artifacts/equity"),
      { runId: "strategy-backtest-run", artifactType: "equity" },
      auth(["backtest:run"]),
    )).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("equity") }] });
    await expect(handler!(
      new URL("portfolio://runs/malformed-signal-run/artifacts/equity"),
      { runId: "malformed-signal-run", artifactType: "equity" },
      auth(["market:read"]),
    )).rejects.toThrow("backtest:run scope가 필요합니다.");
    await expect(handler!(
      new URL("portfolio://runs/malformed-signal-run/artifacts/equity"),
      { runId: "malformed-signal-run", artifactType: "equity" },
      auth(["backtest:run"]),
    )).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("equity") }] });
    await expect(handler!(
      new URL("portfolio://runs/backtest-run/artifacts/equity"),
      { runId: "backtest-run", artifactType: "equity" },
      auth(["backtest:run"]),
    )).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("equity") }] });
    await expect(handler!(
      new URL("portfolio://runs/backtest-run/artifacts/equity"),
      { runId: "backtest-run", artifactType: "equity" },
      auth(["market:read"]),
    )).rejects.toThrow("backtest:run scope가 필요합니다.");
  });
});
