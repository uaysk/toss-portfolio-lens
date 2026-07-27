import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseQualificationArguments,
  qualificationSteps,
} from "./run-ai-p40-qualification.js";

describe("P40 qualification runner plan", () => {
  it("defaults to a six-hour, 48-hour-input, no-build Docker source run", () => {
    const parsed = parseQualificationArguments(
      ["--dry-run"],
      Date.parse("2026-07-27T09:30:45.000Z"),
    );

    expect(parsed).toMatchObject({
      dryRun: true,
      resume: false,
      budgetHours: 6,
      durationHours: 48,
      endExclusive: "2026-07-27T08:29:00.000Z",
      symbols: ["BTCUSDT", "ETHUSDT"],
      workerMode: "docker-source",
      kronosPort: 19_765,
      fincastPort: 19_766,
    });
    expect(path.isAbsolute(parsed.runRoot)).toBe(true);
    expect(qualificationSteps(parsed.symbols)).toHaveLength(9);
  });

  it("builds only selected-symbol replay stages and keeps all speed stages", () => {
    const parsed = parseQualificationArguments([
      "--run-root", "/tmp/ai-runs",
      "--run-id", "manual-test",
      "--budget-hours", "5.5",
      "--duration-hours", "24",
      "--end-exclusive", "2026-07-27T00:00:00Z",
      "--symbols", "btcusdt",
      "--worker-mode", "external",
      "--kronos-port", "20001",
      "--fincast-port", "20002",
    ]);
    const steps = qualificationSteps(parsed.symbols);

    expect(parsed.endExclusive).toBe("2026-07-27T00:00:00.000Z");
    expect(parsed.workerMode).toBe("external");
    expect(steps.map((step) => step.id)).toEqual([
      "preflight",
      "replay-base-btcusdt",
      "replay-cache-btcusdt",
      "fincast-batch-4",
      "fincast-batch-8",
      "fincast-batch-16",
      "finalize",
    ]);
    expect(steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("rejects unsafe run identifiers, invalid symbols, and shared ports", () => {
    expect(() => parseQualificationArguments(["--run-id", "../escape"])).toThrow(
      "unsupported characters",
    );
    expect(() => parseQualificationArguments(["--symbols", "BTCUSD"])).toThrow(
      "Binance USDT",
    );
    expect(() => parseQualificationArguments([
      "--kronos-port", "19000",
      "--fincast-port", "19000",
    ])).toThrow("must differ");
  });
});
