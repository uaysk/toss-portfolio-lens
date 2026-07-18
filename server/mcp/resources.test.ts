import { describe, expect, it } from "vitest";
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
});
