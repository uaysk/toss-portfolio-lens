import { describe, expect, it, vi } from "vitest";
import { SimulationRunEventV1Schema } from "./contracts.js";
import {
  SimulationRunEventHub,
  SimulationRunEventsBusyError,
} from "./run-event-stream.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("SimulationRunEventHub", () => {
  it("assigns monotonic revisions, drops stale publications, and seals terminal runs", () => {
    const hub = new SimulationRunEventHub({ now: () => Date.parse("2026-07-30T00:00:00.000Z") });

    const snapshot = hub.publishSnapshot({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      payload: { snapshot: { progress: 0 } },
    });
    const advanced = hub.publishProgress({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      revision: 3,
      payload: { progress: 0.5 },
    });
    const stale = hub.publishChanged({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      revision: 2,
      payload: { ignored: true },
    });
    const terminal = hub.publishTerminal({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "completed",
      payload: { snapshot: { progress: 1 } },
    });
    const afterTerminal = hub.publishProgress({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      payload: { progress: 0.9 },
    });

    expect(snapshot?.revision).toBe(1);
    expect(advanced?.revision).toBe(3);
    expect(stale).toBeUndefined();
    expect(terminal?.revision).toBe(4);
    expect(afterTerminal).toBeUndefined();
    expect(hub.eventsAfter(RUN_ID, "owner", 1).map((event) => event.revision))
      .toEqual([3, 4]);
    expect(hub.eventsAfter(RUN_ID, "owner", 0).every((event) => (
      SimulationRunEventV1Schema.safeParse(event).success
      && Object.keys(event).sort().join(",")
        === "emittedAt,payload,revision,runId,schemaVersion,type"
      && event.schemaVersion === 1
    ))).toBe(true);
    expect(hub.telemetry).toMatchObject({
      publishedTotal: 3,
      staleDroppedTotal: 1,
      terminalDroppedTotal: 1,
    });
  });

  it("bounds replay memory and reconnect replay starts strictly after Last-Event-ID", () => {
    const hub = new SimulationRunEventHub({ replayLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
      hub.publishProgress({
        runId: RUN_ID,
        ownerSubject: "owner",
        status: "running",
        payload: { index },
      });
    }

    expect(hub.eventsAfter(RUN_ID, "owner", 0).map((event) => event.revision))
      .toEqual([3, 4, 5]);
    expect(hub.eventsAfter(RUN_ID, "owner", 3).map((event) => event.revision))
      .toEqual([4, 5]);
    expect(hub.telemetry).toMatchObject({
      replayRuns: 1,
      replayEventCapacityPerRun: 3,
      replayEvents: 3,
    });
  });

  it("bounds active connections and releases admission on disconnect cleanup", () => {
    const hub = new SimulationRunEventHub({ connectionLimit: 1 });
    const listener = vi.fn();
    const release = hub.subscribe(RUN_ID, "owner", listener);

    expect(hub.telemetry.activeConnections).toBe(1);
    expect(() => hub.subscribe(RUN_ID, "owner", vi.fn()))
      .toThrow(SimulationRunEventsBusyError);
    expect(hub.telemetry.rejectedConnectionsTotal).toBe(1);

    release();
    release();
    expect(hub.telemetry.activeConnections).toBe(0);

    const releaseAgain = hub.subscribe(RUN_ID, "owner", vi.fn());
    expect(hub.telemetry.activeConnections).toBe(1);
    releaseAgain();
    expect(hub.telemetry.activeConnections).toBe(0);
  });

  it("isolates a failed subscriber from the publisher and remaining streams", () => {
    const hub = new SimulationRunEventHub();
    const received = vi.fn();
    const releaseFailed = hub.subscribe(RUN_ID, "owner", () => {
      throw new Error("disconnected");
    });
    const releaseHealthy = hub.subscribe(RUN_ID, "owner", received);

    expect(() => hub.publishProgress({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      payload: { progress: 0.25 },
    })).not.toThrow();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      revision: 1,
      type: "progress",
    }));
    expect(hub.telemetry.deliveryErrorTotal).toBe(1);

    releaseFailed();
    releaseHealthy();
  });
});
