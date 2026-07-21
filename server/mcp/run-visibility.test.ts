import { describe, expect, it } from "vitest";
import { MCP_VISIBLE_RUN_KINDS, isMcpVisibleRunKind, mcpVisibleRun } from "./run-visibility.js";

describe("MCP run visibility", () => {
  it("단타 예측 검증 run은 generic MCP run/resource 표면에서도 숨긴다", () => {
    expect(MCP_VISIBLE_RUN_KINDS).not.toContain("scalping_prediction_evaluation");
    expect(isMcpVisibleRunKind("scalping_prediction_evaluation")).toBe(false);
    expect(mcpVisibleRun({ kind: "scalping_prediction_evaluation", id: "hidden" } as never)).toBeUndefined();
    expect(mcpVisibleRun({ kind: "technical_analysis", id: "visible" } as never)).toMatchObject({ id: "visible" });
  });
});
