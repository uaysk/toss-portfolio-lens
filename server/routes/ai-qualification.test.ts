import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
  AI_QUALIFICATION_STATE_SCHEMA_VERSION,
  type QualificationEvent,
  type QualificationState,
} from "../qualification/contracts.js";
import { createAiQualificationRouter } from "./ai-qualification.js";

const servers: Server[] = [];
const directories: string[] = [];

function fixtureState(runId: string): QualificationState {
  return {
    schemaVersion: AI_QUALIFICATION_STATE_SCHEMA_VERSION,
    runId,
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:00:02.000Z",
    deadlineAt: "2026-07-27T06:00:01.000Z",
    activeStepId: "replay-base-btc",
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
      percent: 50,
      activeStepPercent: 25,
      elapsedMs: 1_000,
      remainingBudgetMs: 21_599_000,
    },
    steps: [
      {
        id: "preflight",
        order: 1,
        label: "사전 점검",
        description: "GPU와 기존 이미지를 확인합니다.",
        model: "system",
        variant: "P40",
        status: "completed",
        estimatedDurationMs: 120_000,
        logFile: "logs/preflight.log",
      },
      {
        id: "replay-base-btc",
        order: 2,
        label: "BTC 기본 리플레이",
        description: "48시간 기준선을 측정합니다.",
        model: "comparison",
        variant: "base",
        status: "running",
        estimatedDurationMs: 6_600_000,
        logFile: "logs/replay-base-btc.log",
      },
    ],
    artifacts: {
      summaryJson: "qualification-summary.json",
      reportMarkdown: "qualification-report.md",
      handoffPrompt: "codex-handoff-prompt.md",
    },
  };
}

async function fixtureRoot(runId = "p40-20260727-test"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-qualification-route-"));
  directories.push(root);
  const state = fixtureState(runId);
  const event: QualificationEvent = {
    schemaVersion: AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
    sequence: 1,
    runId,
    at: "2026-07-27T00:00:02.000Z",
    type: "step_started",
    message: "BTC 기본 리플레이를 시작했습니다.",
    stepId: "replay-base-btc",
    progressPercent: 50,
  };
  await mkdir(path.join(root, runId), { recursive: true });
  await writeFile(path.join(root, "latest.json"), `${JSON.stringify({ runId })}\n`);
  await writeFile(path.join(root, runId, "state.json"), `${JSON.stringify(state)}\n`);
  await writeFile(path.join(root, runId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  return root;
}

async function start(
  root: string,
  authenticate: RequestHandler = (_request, _response, next) => next(),
) {
  const router = createAiQualificationRouter({
    authenticate,
    runRoot: root,
    pollIntervalMs: 250,
    heartbeatMs: 1_000,
  });
  const app = createApp({
    trustProxy: [],
    routeRegistrars: [(application) => application.use(router)],
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AI qualification progress routes", () => {
  it("returns the latest validated state and events without caching", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = await response.json() as { state: QualificationState; events: QualificationEvent[] };
    expect(payload.state.runId).toBe("p40-20260727-test");
    expect(payload.state.progress.percent).toBe(50);
    expect(payload.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("streams the current snapshot and ordered progress events over SSE", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);
    const controller = new AbortController();

    const response = await fetch(
      `${baseUrl}/api/ai-qualification/runs/p40-20260727-test/events`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    const decoder = new TextDecoder();
    let received = "";
    for (let index = 0; index < 4 && !received.includes("event: progress"); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    expect(received).toContain("event: snapshot");
    expect(received).toContain("id: 1");
    expect(received).toContain("event: progress");
    expect(received).toContain("replay-base-btc");
  });

  it("does not expose state without the dashboard session guard", async () => {
    const root = await fixtureRoot();
    const authenticate = vi.fn<RequestHandler>((_request, response) => {
      response.status(401).json({ error: { code: "authentication-required" } });
    });
    const baseUrl = await start(root, authenticate);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);

    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("rejects path-shaped run identifiers as not found", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/%2e%2e`);

    expect(response.status).toBe(404);
  });

  it("rejects a run directory symlink even when its target contains valid state", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "real-run");
    await mkdir(target);
    await writeFile(
      path.join(target, "state.json"),
      `${JSON.stringify(fixtureState("linked-run"))}\n`,
    );
    await symlink(target, path.join(root, "linked-run"));
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/linked-run`);

    expect(response.status).toBe(404);
  });
});
