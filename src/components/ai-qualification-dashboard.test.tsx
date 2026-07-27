import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QualificationState } from "@/lib/ai-qualification";
import { AiQualificationRunView } from "./ai-qualification-dashboard";

function state(): QualificationState {
  return {
    schemaVersion: "ai-p40-qualification-state/v1",
    runId: "p40-ui-test",
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:10:00.000Z",
    deadlineAt: "2026-07-27T06:00:01.000Z",
    activeStepId: "replay-base-btcusdt",
    config: {
      budgetHours: 6,
      durationHours: 48,
      endExclusive: "2026-07-27T00:00:00.000Z",
      symbols: ["BTCUSDT", "ETHUSDT"],
      gpu: "Tesla P40",
      cudaCapability: "6.1",
      workerMode: "docker-source",
      dockerBuild: false,
    },
    progress: {
      completedSteps: 1,
      failedSteps: 0,
      skippedSteps: 0,
      totalSteps: 2,
      percent: 32.5,
      activeStepPercent: 24,
      elapsedMs: 600_000,
      remainingBudgetMs: 21_000_000,
    },
    steps: [
      {
        id: "preflight",
        order: 1,
        label: "P40 사전 점검",
        description: "GPU를 점검합니다.",
        model: "system",
        variant: "docker-build=false",
        status: "completed",
        estimatedDurationMs: 120_000,
        durationMs: 20_000,
        logFile: "logs/preflight.log",
      },
      {
        id: "replay-base-btcusdt",
        order: 2,
        label: "BTCUSDT 기준선 리플레이",
        description: "두 모델을 비교합니다.",
        model: "comparison",
        variant: "base",
        status: "running",
        estimatedDurationMs: 6_600_000,
        logFile: "logs/replay.log",
      },
    ],
    artifacts: {
      summaryJson: "qualification-summary.json",
      reportMarkdown: "qualification-report.md",
      handoffPrompt: "codex-handoff-prompt.md",
    },
    telemetry: {
      polledAt: "2026-07-27T00:10:00.000Z",
      gpuUtilizationPercent: 94,
      memoryUsedMiB: 18_432,
      memoryTotalMiB: 24_576,
      temperatureC: 71,
    },
  };
}

describe("AI qualification dashboard", () => {
  it("renders the live P40 progress, active step, GPU telemetry, and event", () => {
    const markup = renderToStaticMarkup(
      <AiQualificationRunView
        state={state()}
        events={[{
          schemaVersion: "ai-p40-qualification-event/v1",
          sequence: 2,
          runId: "p40-ui-test",
          at: "2026-07-27T00:09:59.000Z",
          type: "step_started",
          message: "BTCUSDT 기준선 리플레이를 시작했습니다.",
        }]}
        connection="live"
      />,
    );

    expect(markup).toContain("SSE LIVE · 1초");
    expect(markup).toContain("32.5");
    expect(markup).toContain("BTCUSDT 기준선 리플레이");
    expect(markup).toContain("94%");
    expect(markup).toContain("18.0 GB");
    expect(markup).toContain("BF16 미사용");
  });
});
