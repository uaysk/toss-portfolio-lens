import { describe, expect, it } from "vitest";
import { MCP_TOOL_DOMAINS } from "./domain-registry.js";
import {
  createPresetManagementHandlers,
  type PresetManagementDependencies,
} from "./preset-management-handlers.js";

describe("preset management handler factory", () => {
  it("공개 preset domain tool 이름을 빠짐없이 동일 순서로 제공한다", () => {
    const handlers = createPresetManagementHandlers({} as PresetManagementDependencies);
    expect(Object.keys(handlers)).toEqual([...MCP_TOOL_DOMAINS.presets]);
    expect(Object.values(handlers).every((handler) => typeof handler === "function")).toBe(true);
  });
});
