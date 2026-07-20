import { describe, expect, it } from "vitest";
import { buildInfo, mcpSchemaHash, resolveGitSha } from "./build-info.js";

describe("build info", () => {
  it("MCP 계약 identity를 결정적으로 노출한다", () => {
    expect(mcpSchemaHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(mcpSchemaHash()).toBe(mcpSchemaHash());
    expect(buildInfo()).toMatchObject({
      mcpToolCount: 53,
      workerSchemaVersion: "1.0",
      mcpSchemaVersion: "1.1",
    });
  });

  it("환경에 명시된 Git SHA를 우선한다", () => {
    const previous = process.env.APP_GIT_SHA;
    process.env.APP_GIT_SHA = "abcdef1";
    try {
      expect(resolveGitSha("/does/not/exist")).toBe("abcdef1");
    } finally {
      if (previous === undefined) delete process.env.APP_GIT_SHA;
      else process.env.APP_GIT_SHA = previous;
    }
  });
});
