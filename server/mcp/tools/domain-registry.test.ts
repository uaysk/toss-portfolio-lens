import { describe, expect, it } from "vitest";
import { toolSchemas, type ToolName } from "../schemas.js";
import {
  createMcpDomainRegistry,
  MCP_TOOL_DOMAINS,
} from "./domain-registry.js";

describe("MCP tool domain registry", () => {
  it("assigns every public tool exactly once and preserves handler identity", () => {
    const handlers = Object.fromEntries(
      Object.keys(toolSchemas).map((name) => [name, Symbol(name)]),
    ) as Record<ToolName, symbol>;
    const registry = createMcpDomainRegistry(handlers);
    const assigned = Object.values(MCP_TOOL_DOMAINS).flat();

    expect(new Set(assigned).size).toBe(Object.keys(toolSchemas).length);
    expect(assigned.toSorted()).toEqual(Object.keys(toolSchemas).toSorted());
    expect(registry.domains.runs.get_run_status).toBe(handlers.get_run_status);
    expect(registry.domains.reports.get_report).toBe(handlers.get_report);
    expect(registry.handlers).toBe(handlers);
  });
});
