import {
  getPairCatalogEntry,
  mapPairDirection,
  validatePairCatalogEntry,
  type PairCatalog,
  type PairCatalogEntry,
  type PairDirection,
} from "./pair-catalog.js";

export const PAIR_STATE_VERSION = "pair-runtime-state/v1" as const;

export type PairPendingTransition = {
  kind: "enter" | "exit";
  direction: "bull" | "bear";
  executionSymbol: string;
  eligibleAfter: string;
  requestedAt: string;
  desiredAfterExit?: "bull" | "bear";
};

export type PairRuntimeState = {
  stateVersion: typeof PAIR_STATE_VERSION;
  pairId: string;
  direction: PairDirection;
  executionSymbol: string | null;
  enteredAt?: string;
  lastTransitionAt?: string;
  cooldownUntil?: string;
  transitionCount: number;
  pending?: PairPendingTransition;
  lastDecisionOrigin?: string;
};

export type PairStateCommand = {
  side: "buy" | "sell";
  direction: "bull" | "bear";
  executionSymbol: string;
  eligibleAfter: string;
};

export type PairStateEvent =
  | {
      type: "decision";
      targetDirection: PairDirection;
      decidedAt: string;
      eligibleAfter: string;
      origin?: string;
    }
  | {
      type: "fill";
      side: "buy" | "sell";
      direction: "bull" | "bear";
      executionSymbol: string;
      executedAt: string;
      cooldownMs: number;
    }
  | {
      type: "cancel_pending";
      at: string;
    };

export type PairStateTransitionResult = {
  status: "applied" | "blocked" | "ignored";
  state: PairRuntimeState;
  commands: PairStateCommand[];
  reasonCodes: string[];
};

function instant(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an RFC3339 timestamp.`);
  return new Date(Date.parse(value)).toISOString();
}

function cloneState(state: PairRuntimeState): PairRuntimeState {
  return {
    ...state,
    ...(state.pending ? { pending: { ...state.pending } } : {}),
  };
}

function pairForState(
  state: PairRuntimeState,
  catalog: PairCatalog,
): Readonly<PairCatalogEntry> {
  if (state.stateVersion !== PAIR_STATE_VERSION) throw new Error("Pair state version is invalid.");
  return getPairCatalogEntry(state.pairId, catalog);
}

export function validatePairMutualExclusion(
  pairInput: PairCatalogEntry,
  positions: Readonly<Record<string, number>>,
): PairDirection {
  const pair = validatePairCatalogEntry(pairInput);
  for (const [symbol, quantity] of Object.entries(positions)) {
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`Position quantity is invalid: ${symbol}`);
    }
  }
  const bullHeld = (positions[pair.bull.executionSymbol] ?? 0) > 0;
  const bearHeld = (positions[pair.bear.executionSymbol] ?? 0) > 0;
  if (bullHeld && bearHeld) {
    throw new Error(`Pair ${pair.pairId} cannot hold bull and bear simultaneously.`);
  }
  return bullHeld ? "bull" : bearHeld ? "bear" : "cash";
}

export function createPairRuntimeState(
  pairInput: PairCatalogEntry,
  positions: Readonly<Record<string, number>> = {},
  observedAt?: string,
): PairRuntimeState {
  const pair = validatePairCatalogEntry(pairInput);
  const direction = validatePairMutualExclusion(pair, positions);
  const at = observedAt ? instant(observedAt, "observedAt") : undefined;
  const mapping = mapPairDirection(pair, direction);
  return {
    stateVersion: PAIR_STATE_VERSION,
    pairId: pair.pairId,
    direction,
    executionSymbol: mapping.executionSymbol,
    ...(direction !== "cash" && at ? { enteredAt: at, lastTransitionAt: at } : {}),
    transitionCount: 0,
  };
}

function validateStateAgainstPair(
  state: PairRuntimeState,
  pair: Readonly<PairCatalogEntry>,
): void {
  const mapping = mapPairDirection(pair, state.direction);
  if (state.executionSymbol !== mapping.executionSymbol) {
    throw new Error("Pair runtime direction and execution symbol are inconsistent.");
  }
  if (!Number.isSafeInteger(state.transitionCount) || state.transitionCount < 0) {
    throw new Error("Pair transition count is invalid.");
  }
  if (state.pending) {
    const pendingMapping = mapPairDirection(pair, state.pending.direction);
    if (pendingMapping.executionSymbol !== state.pending.executionSymbol) {
      throw new Error("Pending pair transition references the wrong execution symbol.");
    }
    instant(state.pending.eligibleAfter, "pending.eligibleAfter");
    instant(state.pending.requestedAt, "pending.requestedAt");
    if (state.pending.kind === "enter" && state.direction !== "cash") {
      throw new Error("An entry may be pending only from cash.");
    }
    if (state.pending.kind === "exit" && state.direction !== state.pending.direction) {
      throw new Error("An exit must match the currently held direction.");
    }
  }
}

export function transitionPairState(
  stateInput: PairRuntimeState,
  event: PairStateEvent,
  catalog: PairCatalog,
): PairStateTransitionResult {
  const state = cloneState(stateInput);
  const pair = pairForState(state, catalog);
  validateStateAgainstPair(state, pair);

  if (event.type === "cancel_pending") {
    instant(event.at, "at");
    if (!state.pending) {
      return { status: "ignored", state, commands: [], reasonCodes: ["no_pending_transition"] };
    }
    if (state.pending.kind === "exit") {
      return {
        status: "blocked",
        state,
        commands: [],
        reasonCodes: ["pending_exit_is_fail_closed"],
      };
    }
    state.pending = undefined;
    return { status: "applied", state, commands: [], reasonCodes: ["pending_entry_cancelled"] };
  }

  if (event.type === "decision") {
    const decidedAt = instant(event.decidedAt, "decidedAt");
    const eligibleAfter = instant(event.eligibleAfter, "eligibleAfter");
    if (Date.parse(eligibleAfter) < Date.parse(decidedAt)) {
      throw new Error("eligibleAfter cannot precede decidedAt.");
    }
    const origin = event.origin ? instant(event.origin, "origin") : undefined;
    if (origin) state.lastDecisionOrigin = origin;

    let replacedPendingEntry = false;
    if (state.pending) {
      if (state.pending.kind === "exit") {
        return {
          status: "blocked",
          state,
          commands: [],
          reasonCodes: ["transition_already_pending"],
        };
      }
      if (event.targetDirection === state.pending.direction) {
        return {
          status: "blocked",
          state,
          commands: [],
          reasonCodes: ["transition_already_pending"],
        };
      }
      if (event.targetDirection === "cash") {
        state.pending = undefined;
        return {
          status: "applied",
          state,
          commands: [],
          reasonCodes: ["pending_entry_cancelled_by_cash"],
        };
      }
      state.pending = undefined;
      replacedPendingEntry = true;
    }

    if (event.targetDirection === state.direction) {
      return {
        status: "ignored",
        state,
        commands: [],
        reasonCodes: [state.direction === "cash" ? "remain_cash" : "held_direction_unchanged"],
      };
    }

    if (state.direction !== "cash") {
      const heldDirection: "bull" | "bear" = state.direction;
      const heldMapping = mapPairDirection(pair, heldDirection);
      if (heldMapping.direction === "cash") {
        throw new Error("A held direction must resolve to an execution instrument.");
      }
      const pending: PairPendingTransition = {
        kind: "exit",
        direction: heldDirection,
        executionSymbol: heldMapping.executionSymbol,
        eligibleAfter,
        requestedAt: decidedAt,
        ...(event.targetDirection !== "cash"
          ? { desiredAfterExit: event.targetDirection } : {}),
      };
      state.pending = pending;
      return {
        status: "applied",
        state,
        commands: [{
          side: "sell",
          direction: heldDirection,
          executionSymbol: pending.executionSymbol,
          eligibleAfter,
        }],
        reasonCodes: event.targetDirection === "cash"
          ? ["exit_to_cash_requested"]
          : ["opposite_direction_requires_exit_first"],
      };
    }

    const cooldownUntil = state.cooldownUntil
      ? instant(state.cooldownUntil, "cooldownUntil")
      : undefined;
    if (cooldownUntil && Date.parse(decidedAt) < Date.parse(cooldownUntil)) {
      return {
        status: "blocked",
        state,
        commands: [],
        reasonCodes: ["cooldown_active"],
      };
    }
    const mapping = mapPairDirection(pair, event.targetDirection);
    if (mapping.direction === "cash") throw new Error("Cash cannot create an entry command.");
    state.pending = {
      kind: "enter",
      direction: mapping.direction,
      executionSymbol: mapping.executionSymbol,
      eligibleAfter,
      requestedAt: decidedAt,
    };
    return {
      status: "applied",
      state,
      commands: [{
        side: "buy",
        direction: mapping.direction,
        executionSymbol: mapping.executionSymbol,
        eligibleAfter,
      }],
      reasonCodes: replacedPendingEntry
        ? ["stale_pending_entry_replaced", "entry_requested_from_cash"]
        : ["entry_requested_from_cash"],
    };
  }

  const executedAt = instant(event.executedAt, "executedAt");
  if (!Number.isSafeInteger(event.cooldownMs) || event.cooldownMs < 0) {
    throw new Error("cooldownMs must be a non-negative safe integer.");
  }
  const pending = state.pending;
  if (!pending
    || pending.direction !== event.direction
    || pending.executionSymbol !== event.executionSymbol
    || (pending.kind === "enter" ? event.side !== "buy" : event.side !== "sell")) {
    return {
      status: "blocked",
      state,
      commands: [],
      reasonCodes: ["fill_does_not_match_pending_transition"],
    };
  }
  if (Date.parse(executedAt) <= Date.parse(pending.eligibleAfter)) {
    return {
      status: "blocked",
      state,
      commands: [],
      reasonCodes: ["fill_not_strictly_after_eligibility"],
    };
  }

  if (pending.kind === "enter") {
    state.direction = pending.direction;
    state.executionSymbol = pending.executionSymbol;
    state.enteredAt = executedAt;
    state.lastTransitionAt = executedAt;
    state.transitionCount += 1;
    state.pending = undefined;
    return {
      status: "applied",
      state,
      commands: [],
      reasonCodes: ["entry_fill_applied"],
    };
  }

  state.direction = "cash";
  state.executionSymbol = null;
  state.enteredAt = undefined;
  state.lastTransitionAt = executedAt;
  state.cooldownUntil = new Date(Date.parse(executedAt) + event.cooldownMs).toISOString();
  state.transitionCount += 1;
  state.pending = undefined;
  return {
    status: "applied",
    state,
    commands: [],
    reasonCodes: pending.desiredAfterExit
      ? ["exit_fill_applied", "opposite_entry_requires_new_post_cooldown_decision"]
      : ["exit_fill_applied"],
  };
}
