import {
  SIMULATION_RUN_EVENT_SCHEMA_VERSION,
  type SimulationRunEventStatus,
  type SimulationRunEventType,
  type SimulationRunEventV1,
} from "./contracts.js";
import { FixedRing } from "../fixed-ring.js";

const DEFAULT_REPLAY_LIMIT = 128;
const DEFAULT_RUN_LIMIT = 512;
const DEFAULT_CONNECTION_LIMIT = 128;

const TERMINAL_STATUSES = new Set<SimulationRunEventStatus>([
  "cancelled",
  "completed",
  "failed",
]);

export type SimulationRunEventPublishInput = {
  runId: string;
  ownerSubject: string;
  status?: SimulationRunEventStatus;
  payload: unknown;
  emittedAt?: string;
  revision?: number;
};

export type SimulationRunEventPublisher = {
  publishSnapshot(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined;
  publishProgress(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined;
  publishChanged(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined;
  publishTerminal(
    input: SimulationRunEventPublishInput & {
      status: Extract<SimulationRunEventStatus, "cancelled" | "completed" | "failed">;
    },
  ): SimulationRunEventV1 | undefined;
};

export type SimulationRunEventTelemetry = {
  capacity: number;
  activeConnections: number;
  rejectedConnectionsTotal: number;
  replayRunCapacity: number;
  replayRuns: number;
  replayEventCapacityPerRun: number;
  replayEvents: number;
  publishedTotal: number;
  staleDroppedTotal: number;
  terminalDroppedTotal: number;
  capacityDroppedTotal: number;
  deliveryErrorTotal: number;
};

type RunState = {
  ownerSubject: string;
  revision: number;
  events: FixedRing<SimulationRunEventV1>;
  latestEvent?: SimulationRunEventV1;
  listeners: Set<(event: SimulationRunEventV1) => void>;
  terminal: boolean;
  touchedAt: number;
};

export class SimulationRunEventsBusyError extends Error {
  readonly code = "SIMULATION_SSE_BUSY";
  readonly retryable = true;

  constructor() {
    super("The simulation event stream connection limit has been reached.");
    this.name = "SimulationRunEventsBusyError";
  }
}

export class SimulationRunEventHub implements SimulationRunEventPublisher {
  private readonly states = new Map<string, RunState>();
  private readonly replayLimit: number;
  private readonly runLimit: number;
  private readonly connectionLimit: number;
  private readonly now: () => number;
  private activeConnections = 0;
  private rejectedConnectionsTotal = 0;
  private publishedTotal = 0;
  private staleDroppedTotal = 0;
  private terminalDroppedTotal = 0;
  private capacityDroppedTotal = 0;
  private deliveryErrorTotal = 0;

  constructor(options: {
    replayLimit?: number;
    runLimit?: number;
    connectionLimit?: number;
    now?: () => number;
  } = {}) {
    this.replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
    this.runLimit = options.runLimit ?? DEFAULT_RUN_LIMIT;
    this.connectionLimit = options.connectionLimit ?? DEFAULT_CONNECTION_LIMIT;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.replayLimit) || this.replayLimit < 2) {
      throw new Error("Simulation SSE replay limit must be at least 2.");
    }
    if (!Number.isInteger(this.runLimit) || this.runLimit < 1) {
      throw new Error("Simulation SSE run limit must be positive.");
    }
    if (!Number.isInteger(this.connectionLimit) || this.connectionLimit < 1) {
      throw new Error("Simulation SSE connection limit must be positive.");
    }
  }

  publishSnapshot(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined {
    return this.publish("snapshot", input);
  }

  publishProgress(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined {
    return this.publish("progress", input);
  }

  publishChanged(input: SimulationRunEventPublishInput): SimulationRunEventV1 | undefined {
    return this.publish("changed", input);
  }

  publishTerminal(
    input: SimulationRunEventPublishInput & {
      status: Extract<SimulationRunEventStatus, "cancelled" | "completed" | "failed">;
    },
  ): SimulationRunEventV1 | undefined {
    return this.publish("terminal", input);
  }

  subscribe(
    runId: string,
    ownerSubject: string,
    listener: (event: SimulationRunEventV1) => void,
  ): () => void {
    if (this.activeConnections >= this.connectionLimit) {
      this.rejectedConnectionsTotal += 1;
      throw new SimulationRunEventsBusyError();
    }
    const state = this.state(runId, ownerSubject);
    if (!state) {
      this.rejectedConnectionsTotal += 1;
      throw new SimulationRunEventsBusyError();
    }
    if (state.ownerSubject !== ownerSubject) {
      throw new Error("Simulation run event ownership does not match.");
    }
    state.listeners.add(listener);
    state.touchedAt = this.now();
    this.activeConnections += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      state.listeners.delete(listener);
      state.touchedAt = this.now();
      this.activeConnections = Math.max(0, this.activeConnections - 1);
    };
  }

  eventsAfter(
    runId: string,
    ownerSubject: string,
    revision: number,
  ): SimulationRunEventV1[] {
    const state = this.states.get(runId);
    if (!state || state.ownerSubject !== ownerSubject) return [];
    state.touchedAt = this.now();
    return state.events.values().filter((event) => event.revision > revision);
  }

  latest(runId: string, ownerSubject: string): SimulationRunEventV1 | undefined {
    const state = this.states.get(runId);
    if (!state || state.ownerSubject !== ownerSubject) return undefined;
    state.touchedAt = this.now();
    return state.latestEvent;
  }

  get telemetry(): SimulationRunEventTelemetry {
    let replayEvents = 0;
    for (const state of this.states.values()) replayEvents += state.events.size;
    return {
      capacity: this.connectionLimit,
      activeConnections: this.activeConnections,
      rejectedConnectionsTotal: this.rejectedConnectionsTotal,
      replayRunCapacity: this.runLimit,
      replayRuns: this.states.size,
      replayEventCapacityPerRun: this.replayLimit,
      replayEvents,
      publishedTotal: this.publishedTotal,
      staleDroppedTotal: this.staleDroppedTotal,
      terminalDroppedTotal: this.terminalDroppedTotal,
      capacityDroppedTotal: this.capacityDroppedTotal,
      deliveryErrorTotal: this.deliveryErrorTotal,
    };
  }

  private publish(
    type: Exclude<SimulationRunEventType, "heartbeat">,
    input: SimulationRunEventPublishInput,
  ): SimulationRunEventV1 | undefined {
    const state = this.state(input.runId, input.ownerSubject);
    if (!state) {
      this.capacityDroppedTotal += 1;
      return undefined;
    }
    if (state.ownerSubject !== input.ownerSubject) {
      this.staleDroppedTotal += 1;
      return undefined;
    }
    if (state.terminal) {
      this.terminalDroppedTotal += 1;
      return undefined;
    }
    const revision = input.revision ?? state.revision + 1;
    if (!Number.isSafeInteger(revision) || revision <= state.revision) {
      this.staleDroppedTotal += 1;
      return undefined;
    }
    const terminal = type === "terminal";
    if (terminal && (!input.status || !TERMINAL_STATUSES.has(input.status))) {
      throw new Error("Simulation terminal events require a terminal status.");
    }
    const event: SimulationRunEventV1 = {
      schemaVersion: SIMULATION_RUN_EVENT_SCHEMA_VERSION,
      runId: input.runId,
      revision,
      type,
      emittedAt: input.emittedAt ?? new Date(this.now()).toISOString(),
      payload: input.payload,
    };
    state.revision = revision;
    state.terminal = terminal;
    state.touchedAt = this.now();
    state.events.push(event);
    state.latestEvent = event;
    this.publishedTotal += 1;
    for (const listener of [...state.listeners]) {
      try {
        listener(event);
      } catch {
        // A disconnected or faulty SSE consumer must never fail the simulation
        // publisher or prevent delivery to the remaining subscribers.
        this.deliveryErrorTotal += 1;
      }
    }
    return event;
  }

  private state(runId: string, ownerSubject: string): RunState | undefined {
    const existing = this.states.get(runId);
    if (existing) return existing;
    if (this.states.size >= this.runLimit) {
      let evictable: [string, RunState] | undefined;
      for (const entry of this.states.entries()) {
        if (entry[1].listeners.size > 0) continue;
        if (!evictable || entry[1].touchedAt < evictable[1].touchedAt) {
          evictable = entry;
        }
      }
      if (!evictable) return undefined;
      this.states.delete(evictable[0]);
    }
    const created: RunState = {
      ownerSubject,
      revision: 0,
      events: new FixedRing(this.replayLimit),
      listeners: new Set(),
      terminal: false,
      touchedAt: this.now(),
    };
    this.states.set(runId, created);
    return created;
  }
}
