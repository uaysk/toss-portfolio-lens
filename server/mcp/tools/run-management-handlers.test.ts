import { describe, expect, it, vi } from "vitest";
import { MCP_TOOL_DOMAINS } from "./domain-registry.js";
import {
  createRunManagementHandlers,
  type RunManagementDependencies,
} from "./run-management-handlers.js";

describe("run management handler factory", () => {
  it("공개 run domain tool 이름을 빠짐없이 동일 순서로 제공한다", () => {
    const handlers = createRunManagementHandlers(
      {} as RunManagementDependencies,
      vi.fn(),
    );
    expect(Object.keys(handlers)).toEqual([...MCP_TOOL_DOMAINS.runs]);
    expect(Object.values(handlers).every((handler) => typeof handler === "function")).toBe(true);
  });
});
