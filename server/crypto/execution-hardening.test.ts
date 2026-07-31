import { describe, expect, it, vi } from "vitest";

import {
  BinanceLiveExecution,
  BinanceTestnetExecution,
  type BinanceOrderTransport,
  type BinancePositionSnapshot,
  type ExecutionGateConfig,
  type ExecutionReconciliationStore,
  type ExecutionSafetySupervisor,
  type FuturesOrderRequest,
  type FuturesOrderResult,
  type StoredExecutionIntent,
  type UnknownExecutionRecord,
} from "./execution.js";

const NOW = 2_000_000;

const entryRequest: FuturesOrderRequest = {
  runId: "run-1",
  clientOrderId: "entry-order-1",
  symbol: "BTCUSDT",
  side: "BUY",
  quantity: 0.1,
  leverage: 3,
  reduceOnly: false,
  marginMode: "isolated",
  positionSide: "BOTH",
  modelLane: "chronos2_base",
  protectiveStopPrice: 95,
  typedConfirmation: "LIVE:run-1:BTCUSDT",
};

function position(amount: number, isolated = true): BinancePositionSnapshot {
  return {
    symbol: "BTCUSDT",
    positionSide: "BOTH",
    positionAmount: amount,
    isolated,
  };
}

function openGates(): ExecutionGateConfig {
  return {
    enabled: true,
    credentialsConfigured: true,
    signedReadSucceeded: true,
    championModel: "chronos2_base",
    tradingPermissionEvidence: {
      tradingAllowed: true,
      source: "binance_signed_account",
      observedAt: NOW - 100,
      expiresAt: NOW + 10_000,
    },
    ipRestrictionQualification: {
      restricted: true,
      attestationId: "operator-attestation-1",
      signedBy: "operations",
      detachedSignature: "base64-signature",
      observedAt: NOW - 100,
      expiresAt: NOW + 10_000,
    },
    testnetQualification: {
      succeeded: true,
      qualificationId: "testnet-qualification-1",
      modelLane: "chronos2_base",
      observedAt: NOW - 100,
      expiresAt: NOW + 10_000,
    },
    accountOneWay: true,
    protectionOrdersHealthy: true,
    accountPositionMatched: true,
    streamSynchronized: true,
    modelFresh: true,
    rateLimitHealthy: true,
    dailyLossGateOpen: true,
  };
}

class TestStore implements ExecutionReconciliationStore {
  readonly issued = new Map<string, StoredExecutionIntent>();
  readonly unknown = new Map<string, UnknownExecutionRecord>();
  readonly resolutions: FuturesOrderResult[] = [];

  constructor(readonly durable: boolean) {}

  async reserve(intent: StoredExecutionIntent): Promise<boolean> {
    if (this.issued.has(intent.clientOrderId)) return false;
    this.issued.set(intent.clientOrderId, structuredClone(intent));
    return true;
  }

  async recordUnknown(record: UnknownExecutionRecord): Promise<void> {
    this.unknown.set(record.intent.clientOrderId, structuredClone(record));
  }

  async loadUnknown(clientOrderId: string): Promise<UnknownExecutionRecord | undefined> {
    const record = this.unknown.get(clientOrderId);
    return record ? structuredClone(record) : undefined;
  }

  async markResolved(clientOrderId: string, result: FuturesOrderResult): Promise<void> {
    this.unknown.delete(clientOrderId);
    this.resolutions.push(structuredClone(result));
  }
}

function transport(input: {
  order?: FuturesOrderResult | Error;
  positions?: Array<BinancePositionSnapshot | undefined>;
} = {}): BinanceOrderTransport {
  const positions = [...(input.positions ?? [position(0, false), position(0.1)])];
  let installedProtection = {
    quantity: 0.1,
    side: "SELL" as const,
    triggerPrice: 95,
  };
  return {
    changeLeverage: vi.fn().mockResolvedValue(undefined),
    submitOrder: input.order instanceof Error
      ? vi.fn().mockRejectedValue(input.order)
      : vi.fn().mockResolvedValue(input.order ?? {
        clientOrderId: entryRequest.clientOrderId,
        status: "FILLED",
        venueOrderId: "venue-order-1",
      }),
    queryOrder: vi.fn().mockResolvedValue({
      clientOrderId: entryRequest.clientOrderId,
      status: "FILLED",
      venueOrderId: "venue-order-1",
    }),
    installProtectiveStop: vi.fn(async (request) => {
      installedProtection = {
        quantity: request.quantity,
        side: request.side,
        triggerPrice: request.triggerPrice,
      };
      return {
        clientAlgoId: request.clientAlgoId,
        status: "ACTIVE" as const,
        venueAlgoId: "algo-1",
        symbol: request.symbol,
        side: request.side,
        positionSide: "BOTH" as const,
        reduceOnly: true as const,
        quantity: request.quantity,
        triggerPrice: request.triggerPrice,
      };
    }),
    queryProtectiveStop: vi.fn(async (clientAlgoId) => ({
      clientAlgoId,
      status: "ACTIVE" as const,
      venueAlgoId: "algo-1",
      symbol: "BTCUSDT",
      side: installedProtection.side,
      positionSide: "BOTH" as const,
      reduceOnly: true as const,
      quantity: installedProtection.quantity,
      triggerPrice: installedProtection.triggerPrice,
    })),
    queryPosition: vi.fn(async () => positions.shift()),
  };
}

function live(
  orderTransport: BinanceOrderTransport,
  store: ExecutionReconciliationStore,
  input: {
    gates?: ExecutionGateConfig;
    evidence?: {
      find: ReturnType<typeof vi.fn>;
    };
    supervisor?: ExecutionSafetySupervisor;
  } = {},
): BinanceLiveExecution {
  return new BinanceLiveExecution(orderTransport, input.gates ?? openGates(), {
    reconciliationStore: store,
    userDataEvidence: input.evidence,
    supervisor: input.supervisor,
    ipRestrictionVerifier: { verify: () => true },
    now: () => NOW,
  });
}

describe("guarded Binance futures execution", () => {
  it("rejects deprecated boolean gates instead of treating them as qualification evidence", () => {
    const legacy = openGates() as ExecutionGateConfig & Record<string, unknown>;
    delete legacy.tradingPermissionEvidence;
    delete legacy.ipRestrictionQualification;
    delete legacy.testnetQualification;
    for (const key of [
      ["trading", "Key", "Enabled"],
      ["ip", "Restricted"],
      ["testnet", "Qualified"],
    ].map((segments) => segments.join(""))) {
      legacy[key] = true;
    }

    expect(() => live(transport(), new TestStore(false), { gates: legacy }))
      .toThrow(/Unknown execution gates are not accepted/);
  });

  it("rejects stale qualification evidence and a qualification for another model", () => {
    const gates = openGates();
    gates.ipRestrictionQualification = {
      ...gates.ipRestrictionQualification!,
      expiresAt: NOW,
    };
    gates.testnetQualification = {
      ...gates.testnetQualification!,
      modelLane: "fincast",
    };
    const execution = live(transport(), new TestStore(true), { gates });
    expect(execution.status().blockers).toEqual(expect.arrayContaining([
      "ip_restriction_qualification",
      "testnet_model_mismatch",
    ]));
  });

  it("does not trust an operator IP attestation without an injected signature verifier", () => {
    const execution = new BinanceLiveExecution(transport(), openGates(), {
      reconciliationStore: new TestStore(true),
      now: () => NOW,
    });
    expect(execution.status().blockers).toContain("ip_restriction_qualification");
  });

  it("submits one isolated MARKET entry, installs one reduce-only algo stop, and verifies both", async () => {
    const orderTransport = transport();
    const store = new TestStore(true);
    const execution = live(orderTransport, store);

    const result = await execution.submit(entryRequest);

    expect(result).toMatchObject({
      status: "FILLED",
      protectionStatus: "ACTIVE",
    });
    expect(result.protectionClientOrderId).toMatch(/\.SL\.[a-f0-9]{8}$/);
    expect(result.protectionClientOrderId).not.toBe(entryRequest.clientOrderId);
    expect(orderTransport.changeLeverage).toHaveBeenCalledTimes(1);
    expect(orderTransport.submitOrder).toHaveBeenCalledTimes(1);
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledTimes(1);
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "SELL",
        quantity: 0.1,
        triggerPrice: 95,
        positionSide: "BOTH",
        reduceOnly: true,
      }),
    );
    expect(orderTransport.queryProtectiveStop).toHaveBeenCalledTimes(1);
    expect(orderTransport.queryPosition).toHaveBeenCalledTimes(2);
    expect(store.unknown.size).toBe(0);
  });

  it("protects only the observed executed quantity of a partial fill", async () => {
    const orderTransport = transport({
      order: {
        clientOrderId: entryRequest.clientOrderId,
        status: "PARTIALLY_FILLED",
        executedQuantity: 0.04,
      },
      positions: [position(0, false), position(0.04)],
    });
    const execution = live(orderTransport, new TestStore(true));

    const result = await execution.submit(entryRequest);

    expect(result).toMatchObject({
      status: "PARTIALLY_FILLED",
      protectionStatus: "ACTIVE",
    });
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 0.04 }),
    );
  });

  it("persists an UNKNOWN order and reconciles user-data evidence before any REST query", async () => {
    const orderTransport = transport({ order: new Error("ambiguous timeout") });
    const store = new TestStore(true);
    const evidence = {
      find: vi.fn().mockResolvedValue({
        kind: "order",
        clientOrderId: entryRequest.clientOrderId,
        observedAt: NOW + 1,
        result: {
          clientOrderId: entryRequest.clientOrderId,
          status: "FILLED",
          venueOrderId: "stream-order-1",
        },
      }),
    };
    const execution = live(orderTransport, store, { evidence });

    expect(await execution.submit(entryRequest)).toMatchObject({ status: "UNKNOWN" });
    expect(store.unknown.get(entryRequest.clientOrderId)).toMatchObject({
      kind: "order",
      queryClientId: entryRequest.clientOrderId,
    });

    const result = await execution.reconcileUnknown(entryRequest.clientOrderId, "BTCUSDT");
    expect(result).toMatchObject({
      status: "FILLED",
      protectionStatus: "ACTIVE",
    });
    expect(orderTransport.submitOrder).toHaveBeenCalledTimes(1);
    expect(orderTransport.queryOrder).not.toHaveBeenCalled();
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledTimes(1);
    expect(store.unknown.size).toBe(0);
  });

  it("uses one explicit query when stream evidence is unavailable and never resubmits", async () => {
    const orderTransport = transport({ order: new Error("ambiguous timeout") });
    const store = new TestStore(true);
    const execution = live(orderTransport, store);

    await execution.submit(entryRequest);
    await execution.reconcileUnknown(entryRequest.clientOrderId, "BTCUSDT");

    expect(orderTransport.submitOrder).toHaveBeenCalledTimes(1);
    expect(orderTransport.queryOrder).toHaveBeenCalledTimes(1);
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledTimes(1);
  });

  it("persists an ambiguous protection outcome and latches entry closed", async () => {
    const orderTransport = transport();
    vi.mocked(orderTransport.installProtectiveStop)
      .mockRejectedValueOnce(new Error("ambiguous algo timeout"));
    const store = new TestStore(true);
    const pauseEntries = vi.fn();
    const execution = live(orderTransport, store, {
      supervisor: {
        snapshot: () => ({}),
        pauseEntries,
      },
    });

    const result = await execution.submit(entryRequest);
    expect(result).toMatchObject({
      status: "UNKNOWN",
      protectionStatus: "UNKNOWN",
    });
    expect(store.unknown.get(entryRequest.clientOrderId)).toMatchObject({
      kind: "protection",
      queryClientId: result.protectionClientOrderId,
    });
    expect(pauseEntries).toHaveBeenCalledWith("protection_orders");
    expect(execution.status().blockers).toContain("protection_orders");
    await expect(execution.submit({
      ...entryRequest,
      clientOrderId: "entry-order-2",
    })).rejects.toThrow("protection_orders");
    expect(orderTransport.installProtectiveStop).toHaveBeenCalledTimes(1);
  });

  it("allows reduce-only risk exits while entry-only safety gates are closed", async () => {
    const gates = openGates();
    gates.streamSynchronized = false;
    gates.modelFresh = false;
    gates.rateLimitHealthy = false;
    gates.dailyLossGateOpen = false;
    const orderTransport = transport({
      order: {
        clientOrderId: "reduce-order-1",
        status: "FILLED",
      },
      positions: [position(0.1), position(0)],
    });
    const execution = new BinanceTestnetExecution(orderTransport, gates, {
      reconciliationStore: new TestStore(false),
      now: () => NOW,
    });
    const result = await execution.submit({
      ...entryRequest,
      clientOrderId: "reduce-order-1",
      side: "SELL",
      reduceOnly: true,
      quantity: 0.1,
      protectiveStopPrice: undefined,
      typedConfirmation: undefined,
    });

    expect(result.status).toBe("FILLED");
    expect(orderTransport.changeLeverage).not.toHaveBeenCalled();
    expect(orderTransport.installProtectiveStop).not.toHaveBeenCalled();
    expect(orderTransport.submitOrder).toHaveBeenCalledTimes(1);
  });

  it("fails before any mutation when account position does not match the intent", async () => {
    const orderTransport = transport({ positions: [position(0.2)] });
    const execution = live(orderTransport, new TestStore(true));

    await expect(execution.submit(entryRequest)).rejects.toThrow("does not match");
    expect(orderTransport.changeLeverage).not.toHaveBeenCalled();
    expect(orderTransport.submitOrder).not.toHaveBeenCalled();
    expect(execution.status().blockers).toContain("position_mismatch");
  });

  it("requires the per-run typed confirmation and server-side champion", async () => {
    const execution = live(transport(), new TestStore(true));
    await expect(execution.submit({
      ...entryRequest,
      typedConfirmation: "LIVE:another-run:BTCUSDT",
    })).rejects.toThrow("typed_confirmation");
    await expect(execution.submit({
      ...entryRequest,
      modelLane: "fincast",
    })).rejects.toThrow("model_mismatch");
  });

  it("does not submit when a mandatory protective stop is absent", async () => {
    const orderTransport = transport();
    const execution = live(orderTransport, new TestStore(true));
    await expect(execution.submit({
      ...entryRequest,
      protectiveStopPrice: undefined,
    })).rejects.toThrow("protective stop");
    expect(orderTransport.submitOrder).not.toHaveBeenCalled();
  });
});
