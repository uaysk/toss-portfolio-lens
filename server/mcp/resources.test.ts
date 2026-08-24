import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { McpResourceRegistry } from "./resources.js";

describe("McpResourceRegistry dashboard market resources", () => {
  it("시장 resource를 생성한 owner에게만 반환한다", () => {
    const registry = new McpResourceRegistry({} as never, {} as never, "none");
    const requestHash = "a".repeat(64);
    const descriptor = registry.storeMarket(requestHash, [{ date: "2026-01-01", value: 1 }], "revision-1", "dashboard-http");

    expect(descriptor.uri).toBe(`market://series/${requestHash}`);
    expect(JSON.parse(registry.getMarket(requestHash, "dashboard-http")?.responseJson ?? "null")).toEqual({
      descriptor,
      data: [{ date: "2026-01-01", value: 1 }],
    });
    expect(registry.getMarket(requestHash, "another-owner")).toBeUndefined();
  });

  it("동일 요청 hash도 owner별 resource를 독립 보관한다", () => {
    const registry = new McpResourceRegistry({} as never, {} as never, "oauth");
    const requestHash = "b".repeat(64);

    registry.storeMarket(requestHash, [{ owner: "first" }], "revision-1", "owner-a");
    registry.storeMarket(requestHash, [{ owner: "second" }], "revision-1", "owner-b");

    expect(JSON.parse(registry.getMarket(requestHash, "owner-a")?.responseJson ?? "null").data).toEqual([{ owner: "first" }]);
    expect(JSON.parse(registry.getMarket(requestHash, "owner-b")?.responseJson ?? "null").data).toEqual([{ owner: "second" }]);
  });

  it("저장 상한을 넘는 resource를 명시적으로 거부하고 기존 snapshot을 보존한다", () => {
    const registry = new McpResourceRegistry({} as never, {} as never, "none", 32);
    const requestHash = "d".repeat(64);
    registry.storeMarket(requestHash, [{ value: 1 }], "revision-1", "local-owner");

    expect(() => registry.storeMarket(
      requestHash,
      [{ value: "x".repeat(64) }],
      "revision-2",
      "local-owner",
    )).toThrow("시장 시계열 resource가 저장 byte 상한을 초과했습니다.");
    expect(JSON.parse(registry.getMarket(requestHash, "local-owner")?.responseJson ?? "null").data)
      .toEqual([{ value: 1 }]);
  });

  it("유효하지 않은 resource byte 상한을 거부한다", () => {
    expect(() => new McpResourceRegistry({} as never, {} as never, "none", 0))
      .toThrow("MCP market resource byte limit must be a positive integer.");
  });

  it("저장 시 만든 불변 JSON snapshot을 반복 resource 조회에 재사용한다", async () => {
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
    const registry = new McpResourceRegistry({} as never, {} as never, "none");
    registry.register(server as never);
    const content = [{ date: "2026-01-01", value: 1 }];
    const requestHash = "c".repeat(64);
    registry.storeMarket(requestHash, content, "revision-1", "local-owner");
    content[0]!.value = 2;
    const handler = handlers.get("market-price-series");
    expect(handler).toBeDefined();
    const stringify = vi.spyOn(JSON, "stringify");

    const first = await handler!(new URL(`market://series/${requestHash}`), { requestHash }, {});
    const second = await handler!(new URL(`market://series/${requestHash}`), { requestHash }, {});

    expect(first.contents[0]?.text).toBe(second.contents[0]?.text);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    const parsed = JSON.parse(first.contents[0]?.text ?? "null") as {
      descriptor: { checksum: string };
      data: unknown;
    };
    expect(parsed.data).toEqual([{ date: "2026-01-01", value: 1 }]);
    expect(parsed.descriptor.checksum).toBe(
      createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"),
    );
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
