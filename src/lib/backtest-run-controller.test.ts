import { describe, expect, it } from "vitest";
import { BacktestRunController } from "./backtest-run-controller";

describe("BacktestRunController", () => {
  it("accepts the latest run while its execution context is unchanged", () => {
    const controller = new BacktestRunController({ strategyMode: "allocation", fingerprint: "config-a" });
    const token = controller.begin();

    expect(controller.accepts(token)).toBe(true);
    expect(controller.isLatest(token)).toBe(true);
  });

  it("rejects an older response after a newer run starts", () => {
    const controller = new BacktestRunController({ strategyMode: "allocation", fingerprint: "config-a" });
    const first = controller.begin();
    const second = controller.begin();

    expect(controller.accepts(first)).toBe(false);
    expect(controller.isLatest(first)).toBe(false);
    expect(controller.accepts(second)).toBe(true);
  });

  it("rejects a response when the strategy or request fingerprint changes", () => {
    const controller = new BacktestRunController({ strategyMode: "allocation", fingerprint: "config-a" });
    const token = controller.begin();

    controller.updateContext({ strategyMode: "technical_signal", fingerprint: "config-b" });

    expect(controller.accepts(token)).toBe(false);
    expect(controller.isLatest(token)).toBe(true);
  });
});
