import { createHash } from "node:crypto";

import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DerivativesTradingUsdsFutures,
  DerivativesTradingUsdsFuturesRestAPI,
} from "@binance/derivatives-trading-usds-futures";

export type FuturesExecutionMode = "paper" | "testnet" | "live";
export type FuturesOrderStatus =
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "UNKNOWN";
export type FuturesProtectionStatus =
  | "ACTIVE"
  | "TRIGGERED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "UNKNOWN";

export type FuturesOrderRequest = {
  runId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  leverage: number;
  reduceOnly: boolean;
  marginMode: "isolated";
  positionSide: "BOTH";
  modelLane: "chronos2_base" | "fincast";
  /**
   * Required by the guarded Binance adapters for a new position. Paper
   * execution keeps this optional so the live-only field does not leak into
   * the paper ledger contract.
   */
  protectiveStopPrice?: number;
  typedConfirmation?: string;
};

export type FuturesOrderResult = {
  clientOrderId: string;
  status: FuturesOrderStatus;
  venueOrderId?: string;
  executedQuantity?: number;
  protectionClientOrderId?: string;
  protectionStatus?: FuturesProtectionStatus;
  message?: string;
};

export type FuturesExecutionStatus = {
  mode: FuturesExecutionMode;
  realOrder: boolean;
  credentialsConfigured: boolean;
  signedReadSucceeded: boolean;
  gate: "open" | "closed";
  blockers: string[];
};

export interface FuturesExecution {
  readonly mode: FuturesExecutionMode;
  status(): FuturesExecutionStatus;
  submit(request: FuturesOrderRequest): Promise<FuturesOrderResult>;
  reconcileUnknown(clientOrderId: string, symbol: string): Promise<FuturesOrderResult>;
}

export type BinanceProtectionResult = {
  clientAlgoId: string;
  status: FuturesProtectionStatus;
  venueAlgoId?: string;
  symbol?: string;
  side?: "BUY" | "SELL";
  positionSide?: string;
  reduceOnly?: boolean;
  quantity?: number;
  triggerPrice?: number;
};

export type BinancePositionSnapshot = {
  symbol: string;
  positionSide: string;
  positionAmount: number;
  isolated: boolean;
};

export type BinanceProtectiveStopRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  triggerPrice: number;
  clientAlgoId: string;
  positionSide: "BOTH";
  reduceOnly: true;
};

export type BinanceOrderTransport = {
  changeLeverage(symbol: string, leverage: number): Promise<void>;
  submitOrder(request: FuturesOrderRequest): Promise<FuturesOrderResult>;
  queryOrder(symbol: string, clientOrderId: string): Promise<FuturesOrderResult | undefined>;
  installProtectiveStop(
    request: BinanceProtectiveStopRequest,
  ): Promise<BinanceProtectionResult>;
  queryProtectiveStop(clientAlgoId: string): Promise<BinanceProtectionResult | undefined>;
  queryPosition(symbol: string): Promise<BinancePositionSnapshot | undefined>;
};

type BinanceSdkResponse = { data(): unknown | Promise<unknown> };
export type BinanceOfficialRestApi = {
  changeMarginType(input: unknown): Promise<BinanceSdkResponse>;
  changeInitialLeverage(input: unknown): Promise<BinanceSdkResponse>;
  newOrder(input: unknown): Promise<BinanceSdkResponse>;
  queryOrder(input: unknown): Promise<BinanceSdkResponse>;
  newAlgoOrder(input: unknown): Promise<BinanceSdkResponse>;
  queryAlgoOrder(input: unknown): Promise<BinanceSdkResponse>;
  positionInformationV2(input?: unknown): Promise<BinanceSdkResponse>;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function binanceOrderStatus(value: unknown): FuturesOrderStatus {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "NEW" || normalized === "PENDING_NEW") return "ACCEPTED";
  if (normalized === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
  if (normalized === "FILLED") return "FILLED";
  if (normalized === "CANCELED" || normalized === "CANCELLED") return "CANCELLED";
  if (["REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(normalized)) return "REJECTED";
  return "UNKNOWN";
}

function binanceProtectionStatus(value: unknown): FuturesProtectionStatus {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (["NEW", "WORKING", "PENDING_NEW"].includes(normalized)) return "ACTIVE";
  if (normalized === "TRIGGERED") return "TRIGGERED";
  if (normalized === "FILLED" || normalized === "FINISHED") return "FILLED";
  if (normalized === "CANCELED" || normalized === "CANCELLED") return "CANCELLED";
  if (["REJECTED", "EXPIRED"].includes(normalized)) return "REJECTED";
  return "UNKNOWN";
}

function normalizedVenueOrder(
  payload: unknown,
  requestedClientOrderId: string,
): FuturesOrderResult {
  const response = record(payload);
  const clientOrderId = typeof response?.clientOrderId === "string"
    ? response.clientOrderId
    : requestedClientOrderId;
  const venueOrderId = stringValue(response?.orderId);
  const executedQuantity = finiteNumber(response?.executedQty ?? response?.cumQty);
  return {
    clientOrderId,
    status: binanceOrderStatus(response?.status),
    ...(venueOrderId ? { venueOrderId } : {}),
    ...(executedQuantity !== undefined && executedQuantity >= 0
      ? { executedQuantity }
      : {}),
  };
}

function normalizedProtection(
  payload: unknown,
  requestedClientAlgoId: string,
): BinanceProtectionResult {
  const response = record(payload);
  const side = response?.side === "BUY" || response?.side === "SELL"
    ? response.side
    : undefined;
  const reduceOnly = typeof response?.reduceOnly === "boolean"
    ? response.reduceOnly
    : response?.reduceOnly === "true"
      ? true
      : response?.reduceOnly === "false"
        ? false
        : undefined;
  return {
    clientAlgoId: typeof response?.clientAlgoId === "string"
      ? response.clientAlgoId
      : requestedClientAlgoId,
    status: binanceProtectionStatus(response?.algoStatus ?? response?.status),
    ...(stringValue(response?.algoId)
      ? { venueAlgoId: stringValue(response?.algoId) }
      : {}),
    ...(typeof response?.symbol === "string" ? { symbol: response.symbol } : {}),
    ...(side ? { side } : {}),
    ...(typeof response?.positionSide === "string"
      ? { positionSide: response.positionSide }
      : {}),
    ...(reduceOnly !== undefined ? { reduceOnly } : {}),
    ...(finiteNumber(response?.quantity) !== undefined
      ? { quantity: finiteNumber(response?.quantity) }
      : {}),
    ...(finiteNumber(response?.triggerPrice) !== undefined
      ? { triggerPrice: finiteNumber(response?.triggerPrice) }
      : {}),
  };
}

function alreadyIsolated(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
  };
  return Number(candidate.code) === -4046
    || Number(candidate.response?.data?.code) === -4046;
}

export class OfficialBinanceUsdmOrderTransport implements BinanceOrderTransport {
  private readonly rest: BinanceOfficialRestApi;

  constructor(input: {
    environment: "testnet" | "live";
    apiKey: string;
    apiSecret: string;
    timeoutMs?: number;
    rest?: BinanceOfficialRestApi;
  }) {
    if (!input.apiKey || !input.apiSecret) {
      throw new Error("Binance order transport requires explicit credentials.");
    }
    if (input.rest) {
      this.rest = input.rest;
      return;
    }
    const client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
        basePath: input.environment === "testnet"
          ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
          : DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
        timeout: input.timeoutMs ?? 5_000,
        // Trading mutations are deliberately never retried by the SDK.
        retries: 0,
      },
    });
    this.rest = client.restAPI;
  }

  async changeLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await (await this.rest.changeMarginType({
        symbol,
        marginType: DerivativesTradingUsdsFuturesRestAPI
          .ChangeMarginTypeMarginTypeEnum.ISOLATED,
      })).data();
    } catch (error) {
      if (!alreadyIsolated(error)) throw error;
    }
    await (await this.rest.changeInitialLeverage({ symbol, leverage })).data();
  }

  async submitOrder(request: FuturesOrderRequest): Promise<FuturesOrderResult> {
    const response = await this.rest.newOrder({
      symbol: request.symbol,
      side: request.side === "BUY"
        ? DerivativesTradingUsdsFuturesRestAPI.NewOrderSideEnum.BUY
        : DerivativesTradingUsdsFuturesRestAPI.NewOrderSideEnum.SELL,
      type: DerivativesTradingUsdsFuturesRestAPI.NewOrderTypeEnum.MARKET,
      positionSide: "BOTH",
      reduceOnly: request.reduceOnly
        ? DerivativesTradingUsdsFuturesRestAPI.NewOrderReduceOnlyEnum.TRUE
        : DerivativesTradingUsdsFuturesRestAPI.NewOrderReduceOnlyEnum.FALSE,
      quantity: request.quantity,
      newClientOrderId: request.clientOrderId,
      newOrderRespType: DerivativesTradingUsdsFuturesRestAPI
        .NewOrderNewOrderRespTypeEnum.RESULT,
    });
    return normalizedVenueOrder(await response.data(), request.clientOrderId);
  }

  async queryOrder(
    symbol: string,
    clientOrderId: string,
  ): Promise<FuturesOrderResult | undefined> {
    const response = await this.rest.queryOrder({
      symbol,
      origClientOrderId: clientOrderId,
    });
    return normalizedVenueOrder(await response.data(), clientOrderId);
  }

  async installProtectiveStop(
    request: BinanceProtectiveStopRequest,
  ): Promise<BinanceProtectionResult> {
    const response = await this.rest.newAlgoOrder({
      algoType: DerivativesTradingUsdsFuturesRestAPI.NewAlgoOrderAlgoTypeEnum.CONDITIONAL,
      symbol: request.symbol,
      side: request.side,
      type: DerivativesTradingUsdsFuturesRestAPI.NewAlgoOrderTypeEnum.STOP_MARKET,
      positionSide: "BOTH",
      quantity: request.quantity,
      triggerPrice: request.triggerPrice,
      workingType: DerivativesTradingUsdsFuturesRestAPI
        .NewAlgoOrderWorkingTypeEnum.MARK_PRICE,
      priceProtect: DerivativesTradingUsdsFuturesRestAPI
        .NewAlgoOrderPriceProtectEnum.FALSE,
      reduceOnly: DerivativesTradingUsdsFuturesRestAPI.NewAlgoOrderReduceOnlyEnum.TRUE,
      clientAlgoId: request.clientAlgoId,
      newOrderRespType: DerivativesTradingUsdsFuturesRestAPI
        .NewAlgoOrderNewOrderRespTypeEnum.RESULT,
    });
    return normalizedProtection(await response.data(), request.clientAlgoId);
  }

  async queryProtectiveStop(
    clientAlgoId: string,
  ): Promise<BinanceProtectionResult | undefined> {
    const response = await this.rest.queryAlgoOrder({ clientAlgoId });
    return normalizedProtection(await response.data(), clientAlgoId);
  }

  async queryPosition(symbol: string): Promise<BinancePositionSnapshot | undefined> {
    const response = await this.rest.positionInformationV2({ symbol });
    const payload = await response.data();
    const positions = Array.isArray(payload) ? payload : [];
    const item = positions
      .map((value) => record(value))
      .find((value) => value?.symbol === symbol && value?.positionSide === "BOTH");
    if (!item) return undefined;
    const positionAmount = finiteNumber(item.positionAmt);
    if (positionAmount === undefined) return undefined;
    return {
      symbol,
      positionSide: "BOTH",
      positionAmount,
      isolated: item.isolated === true || item.isolated === "true",
    };
  }
}

export type TimedExecutionEvidence = {
  observedAt: number;
  expiresAt: number;
};

export type TradingPermissionEvidence = TimedExecutionEvidence & {
  tradingAllowed: true;
  source: "binance_signed_account";
};

/**
 * Binance's account API does not attest that a key is IP restricted. This is
 * therefore explicit, signed operator qualification evidence, not an exchange
 * observation.
 */
export type IpRestrictionQualification = TimedExecutionEvidence & {
  restricted: true;
  attestationId: string;
  signedBy: string;
  detachedSignature: string;
};

export type TestnetQualification = TimedExecutionEvidence & {
  succeeded: true;
  qualificationId: string;
  modelLane: "chronos2_base" | "fincast";
};

export type ExecutionGateConfig = {
  enabled: boolean;
  credentialsConfigured: boolean;
  signedReadSucceeded: boolean;
  championModel?: "chronos2_base" | "fincast";
  tradingPermissionEvidence?: TradingPermissionEvidence;
  ipRestrictionQualification?: IpRestrictionQualification;
  testnetQualification?: TestnetQualification;
  accountOneWay?: boolean;
  protectionOrdersHealthy?: boolean;
  accountPositionMatched?: boolean;
  streamSynchronized?: boolean;
  modelFresh?: boolean;
  rateLimitHealthy?: boolean;
  dailyLossGateOpen?: boolean;
};

const EXECUTION_GATE_KEYS = new Set<keyof ExecutionGateConfig>([
  "enabled",
  "credentialsConfigured",
  "signedReadSucceeded",
  "championModel",
  "tradingPermissionEvidence",
  "ipRestrictionQualification",
  "testnetQualification",
  "accountOneWay",
  "protectionOrdersHealthy",
  "accountPositionMatched",
  "streamSynchronized",
  "modelFresh",
  "rateLimitHealthy",
  "dailyLossGateOpen",
]);

export type StoredExecutionIntent = {
  mode: "testnet" | "live";
  runId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  leverage: number;
  reduceOnly: boolean;
  protectiveStopPrice?: number;
  modelLane: "chronos2_base" | "fincast";
  issuedAt: number;
  prePositionAmount?: number;
};

export type UnknownExecutionRecord = {
  version: 1;
  intent: StoredExecutionIntent;
  kind: "order" | "protection";
  queryClientId: string;
  recordedAt: number;
  knownOrderResult?: FuturesOrderResult;
};

export interface ExecutionReconciliationStore {
  readonly durable: boolean;
  reserve(intent: StoredExecutionIntent): Promise<boolean>;
  recordUnknown(record: UnknownExecutionRecord): Promise<void>;
  loadUnknown(clientOrderId: string): Promise<UnknownExecutionRecord | undefined>;
  markResolved(clientOrderId: string, result: FuturesOrderResult): Promise<void>;
}

export class InMemoryExecutionReconciliationStore implements ExecutionReconciliationStore {
  readonly durable = false;
  private readonly reserved = new Set<string>();
  private readonly unknown = new Map<string, UnknownExecutionRecord>();

  async reserve(intent: StoredExecutionIntent): Promise<boolean> {
    if (this.reserved.has(intent.clientOrderId)) return false;
    this.reserved.add(intent.clientOrderId);
    return true;
  }

  async recordUnknown(entry: UnknownExecutionRecord): Promise<void> {
    this.unknown.set(entry.intent.clientOrderId, structuredClone(entry));
  }

  async loadUnknown(clientOrderId: string): Promise<UnknownExecutionRecord | undefined> {
    const entry = this.unknown.get(clientOrderId);
    return entry ? structuredClone(entry) : undefined;
  }

  async markResolved(clientOrderId: string): Promise<void> {
    this.unknown.delete(clientOrderId);
  }
}

export type ExecutionUserDataEvidence =
  | {
    kind: "order";
    clientOrderId: string;
    observedAt: number;
    result: FuturesOrderResult;
  }
  | {
    kind: "protection";
    clientOrderId: string;
    observedAt: number;
    result: BinanceProtectionResult;
  };

export interface ExecutionUserDataEvidenceSource {
  find(
    kind: "order" | "protection",
    clientOrderId: string,
  ): Promise<ExecutionUserDataEvidence | undefined>;
}

export type ExecutionSafetySnapshot = {
  accountOneWay?: boolean;
  protectionOrdersHealthy?: boolean;
  accountPositionMatched?: boolean;
  streamSynchronized?: boolean;
  modelFresh?: boolean;
  rateLimitHealthy?: boolean;
  dailyLossGateOpen?: boolean;
};

export interface ExecutionSafetySupervisor {
  snapshot(): ExecutionSafetySnapshot;
  pauseEntries(reason: string): void | Promise<void>;
}

export interface IpRestrictionQualificationVerifier {
  verify(evidence: IpRestrictionQualification): boolean;
}

export type GuardedExecutionDependencies = {
  reconciliationStore?: ExecutionReconciliationStore;
  userDataEvidence?: ExecutionUserDataEvidenceSource;
  supervisor?: ExecutionSafetySupervisor;
  ipRestrictionVerifier?: IpRestrictionQualificationVerifier;
  now?: () => number;
};

function validateRequest(
  request: FuturesOrderRequest,
  maximumLeverage: number,
  requireProtectiveStop: boolean,
): void {
  if (!/^[A-Za-z0-9._:-]{1,36}$/.test(request.clientOrderId)) {
    throw new Error("clientOrderId is invalid.");
  }
  if (!/^[A-Z0-9]{2,32}$/.test(request.symbol)) throw new Error("symbol is invalid.");
  if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
    throw new Error("quantity is invalid.");
  }
  if (!Number.isInteger(request.leverage)
    || request.leverage < 1 || request.leverage > maximumLeverage) {
    throw new Error(`leverage must be between 1 and ${maximumLeverage}.`);
  }
  if (request.marginMode !== "isolated" || request.positionSide !== "BOTH") {
    throw new Error("Only isolated, one-way futures execution is supported.");
  }
  if (requireProtectiveStop && !request.reduceOnly
    && (!Number.isFinite(request.protectiveStopPrice)
      || (request.protectiveStopPrice ?? 0) <= 0)) {
    throw new Error("A protective stop price is required for every new Binance position.");
  }
}

function evidenceIsFresh(
  evidence: TimedExecutionEvidence | undefined,
  now: number,
): evidence is TimedExecutionEvidence {
  return Boolean(evidence)
    && Number.isFinite(evidence?.observedAt)
    && Number.isFinite(evidence?.expiresAt)
    && (evidence?.observedAt ?? Infinity) <= now
    && (evidence?.expiresAt ?? -Infinity) > now
    && (evidence?.expiresAt ?? 0) > (evidence?.observedAt ?? 0);
}

function protectionClientId(clientOrderId: string): string {
  const suffix = createHash("sha256").update(clientOrderId).digest("hex").slice(0, 8);
  return `${clientOrderId.slice(0, 23)}.SL.${suffix}`;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: { code?: unknown } };
  };
  const status = Number(candidate.status ?? candidate.response?.status);
  const code = Number(candidate.code ?? candidate.response?.data?.code);
  return status === 418 || status === 429 || code === -1003;
}

function positionMatchesPreflight(
  request: FuturesOrderRequest,
  position: BinancePositionSnapshot | undefined,
): position is BinancePositionSnapshot {
  if (!position
    || position.symbol !== request.symbol
    || position.positionSide !== "BOTH"
    || !Number.isFinite(position.positionAmount)) {
    return false;
  }
  if (!request.reduceOnly) return Math.abs(position.positionAmount) < 1e-12;
  if (request.side === "SELL" && position.positionAmount <= 0) return false;
  if (request.side === "BUY" && position.positionAmount >= 0) return false;
  return request.quantity <= Math.abs(position.positionAmount) + 1e-12;
}

function positionMatchesAfter(
  intent: StoredExecutionIntent,
  position: BinancePositionSnapshot | undefined,
): boolean {
  if (!position
    || position.symbol !== intent.symbol
    || position.positionSide !== "BOTH"
    || !position.isolated
    || !Number.isFinite(position.positionAmount)) {
    return false;
  }
  if (!intent.reduceOnly) {
    return intent.side === "BUY"
      ? position.positionAmount > 0
      : position.positionAmount < 0;
  }
  const before = intent.prePositionAmount;
  if (before === undefined) return false;
  if (before > 0 && position.positionAmount < -1e-12) return false;
  if (before < 0 && position.positionAmount > 1e-12) return false;
  return Math.abs(position.positionAmount) <= Math.abs(before) + 1e-12;
}

function verifiedProtection(
  result: BinanceProtectionResult | undefined,
  expected: BinanceProtectiveStopRequest,
): boolean {
  if (!result || !["ACTIVE", "TRIGGERED", "FILLED"].includes(result.status)) return false;
  return result.clientAlgoId === expected.clientAlgoId
    && result.symbol === expected.symbol
    && result.side === expected.side
    && result.positionSide === "BOTH"
    && result.reduceOnly === true
    && result.quantity !== undefined
    && Math.abs(result.quantity - expected.quantity)
      <= Math.max(1e-12, Math.abs(expected.quantity) * 1e-10)
    && result.triggerPrice !== undefined
    && Math.abs(result.triggerPrice - expected.triggerPrice)
      <= Math.max(1e-12, Math.abs(expected.triggerPrice) * 1e-10);
}

export class PaperExecution implements FuturesExecution {
  readonly mode = "paper" as const;
  private readonly orderIds = new Set<string>();

  status(): FuturesExecutionStatus {
    return {
      mode: "paper",
      realOrder: false,
      credentialsConfigured: false,
      signedReadSucceeded: false,
      gate: "open",
      blockers: [],
    };
  }

  async submit(request: FuturesOrderRequest): Promise<FuturesOrderResult> {
    validateRequest(request, 15, false);
    if (this.orderIds.has(request.clientOrderId)) {
      throw new Error("clientOrderId must be unique.");
    }
    this.orderIds.add(request.clientOrderId);
    return { clientOrderId: request.clientOrderId, status: "ACCEPTED" };
  }

  async reconcileUnknown(clientOrderId: string): Promise<FuturesOrderResult> {
    return {
      clientOrderId,
      status: this.orderIds.has(clientOrderId) ? "ACCEPTED" : "UNKNOWN",
    };
  }
}

abstract class GuardedBinanceExecution implements FuturesExecution {
  abstract readonly mode: "testnet" | "live";
  private readonly reconciliationStore: ExecutionReconciliationStore;
  private readonly userDataEvidence?: ExecutionUserDataEvidenceSource;
  private readonly supervisor?: ExecutionSafetySupervisor;
  private readonly ipRestrictionVerifier?: IpRestrictionQualificationVerifier;
  private readonly clock: () => number;
  private readonly entryPauses = new Set<string>();

  constructor(
    protected readonly transport: BinanceOrderTransport,
    protected readonly gates: ExecutionGateConfig,
    dependencies: GuardedExecutionDependencies = {},
  ) {
    const rawGates = gates as ExecutionGateConfig & Record<string, unknown>;
    const unknown = Object.keys(rawGates)
      .filter((key) => !EXECUTION_GATE_KEYS.has(key as keyof ExecutionGateConfig));
    if (unknown.length) {
      throw new Error(`Unknown execution gates are not accepted: ${unknown.join(", ")}`);
    }
    this.reconciliationStore = dependencies.reconciliationStore
      ?? new InMemoryExecutionReconciliationStore();
    this.userDataEvidence = dependencies.userDataEvidence;
    this.supervisor = dependencies.supervisor;
    this.ipRestrictionVerifier = dependencies.ipRestrictionVerifier;
    this.clock = dependencies.now ?? Date.now;
  }

  protected abstract blockersFor(request?: FuturesOrderRequest): string[];
  protected abstract maximumLeverage(): number;

  protected storeBlockers(): string[] {
    return this.mode === "live" && !this.reconciliationStore.durable
      ? ["durable_reconciliation"]
      : [];
  }

  protected runtimeBlockers(request?: FuturesOrderRequest): string[] {
    if (request?.reduceOnly) return [];
    const snapshot = {
      accountOneWay: this.gates.accountOneWay,
      protectionOrdersHealthy: this.gates.protectionOrdersHealthy,
      accountPositionMatched: this.gates.accountPositionMatched,
      streamSynchronized: this.gates.streamSynchronized,
      modelFresh: this.gates.modelFresh,
      rateLimitHealthy: this.gates.rateLimitHealthy,
      dailyLossGateOpen: this.gates.dailyLossGateOpen,
      ...this.supervisor?.snapshot(),
    };
    return [
      ...(snapshot.protectionOrdersHealthy !== true ? ["protection_orders"] : []),
      ...(snapshot.accountPositionMatched !== true ? ["position_mismatch"] : []),
      ...(snapshot.streamSynchronized !== true ? ["stream_desync"] : []),
      ...(snapshot.modelFresh !== true ? ["model_stale"] : []),
      ...(snapshot.rateLimitHealthy !== true ? ["rate_limit"] : []),
      ...(snapshot.dailyLossGateOpen !== true ? ["daily_loss"] : []),
      ...this.entryPauses,
    ];
  }

  protected commonBlockers(request?: FuturesOrderRequest): string[] {
    const snapshot = {
      accountOneWay: this.gates.accountOneWay,
      ...this.supervisor?.snapshot(),
    };
    return [
      ...(!this.gates.enabled ? ["disabled"] : []),
      ...(!this.gates.credentialsConfigured ? ["credentials"] : []),
      ...(!this.gates.signedReadSucceeded ? ["signed_read"] : []),
      ...(snapshot.accountOneWay !== true ? ["position_mode"] : []),
      ...this.storeBlockers(),
      ...this.runtimeBlockers(request),
    ];
  }

  status(): FuturesExecutionStatus {
    const blockers = this.blockersFor();
    return {
      mode: this.mode,
      realOrder: this.mode === "live" && blockers.length === 0,
      credentialsConfigured: this.gates.credentialsConfigured,
      signedReadSucceeded: this.gates.signedReadSucceeded,
      gate: blockers.length ? "closed" : "open",
      blockers,
    };
  }

  async submit(request: FuturesOrderRequest): Promise<FuturesOrderResult> {
    validateRequest(request, this.maximumLeverage(), true);
    const blockers = this.blockersFor(request);
    if (blockers.length) throw new Error(`Execution gate is closed: ${blockers.join(", ")}`);

    const issuedAt = this.currentTime();
    let prePosition: BinancePositionSnapshot | undefined;
    try {
      prePosition = await this.transport.queryPosition(request.symbol);
    } catch (error) {
      await this.pause("position_mismatch");
      if (isRateLimitError(error)) await this.pause("rate_limit");
      throw new Error("Account position reconciliation failed before order submission.");
    }
    if (!positionMatchesPreflight(request, prePosition)) {
      await this.pause("position_mismatch");
      throw new Error("Account position does not match the isolated one-way order intent.");
    }

    const intent: StoredExecutionIntent = {
      mode: this.mode,
      runId: request.runId,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      leverage: request.leverage,
      reduceOnly: request.reduceOnly,
      ...(request.protectiveStopPrice !== undefined
        ? { protectiveStopPrice: request.protectiveStopPrice }
        : {}),
      modelLane: request.modelLane,
      issuedAt,
      prePositionAmount: prePosition.positionAmount,
    };
    let reserved: boolean;
    try {
      reserved = await this.reconciliationStore.reserve(intent);
    } catch {
      await this.pause("durable_reconciliation");
      throw new Error("Execution intent could not be durably reserved.");
    }
    if (!reserved) throw new Error("clientOrderId must be unique.");

    if (!request.reduceOnly) {
      try {
        // Margin/leverage mutations are invoked once and never automatically retried.
        await this.transport.changeLeverage(request.symbol, request.leverage);
      } catch (error) {
        if (isRateLimitError(error)) await this.pause("rate_limit");
        return {
          clientOrderId: request.clientOrderId,
          status: "REJECTED",
          message: "Margin or leverage setup failed before order submission.",
        };
      }
    }

    let result: FuturesOrderResult;
    try {
      // Market submission is invoked once. A thrown outcome is UNKNOWN, never retried.
      result = await this.transport.submitOrder(request);
    } catch (error) {
      if (isRateLimitError(error)) await this.pause("rate_limit");
      await this.persistUnknown(intent, "order", request.clientOrderId);
      return {
        clientOrderId: request.clientOrderId,
        status: "UNKNOWN",
        message: "Submission outcome requires explicit reconciliation.",
      };
    }
    if (result.status === "UNKNOWN") {
      await this.persistUnknown(intent, "order", request.clientOrderId);
      return {
        ...result,
        message: "Submission outcome requires explicit reconciliation.",
      };
    }
    if (!["ACCEPTED", "PARTIALLY_FILLED", "FILLED"].includes(result.status)) return result;

    if (!request.reduceOnly) {
      const protectedResult = await this.installAndVerifyProtection(intent, result);
      if (protectedResult.protectionStatus !== "ACTIVE"
        && protectedResult.protectionStatus !== "TRIGGERED"
        && protectedResult.protectionStatus !== "FILLED") {
        return protectedResult;
      }
      return this.reconcilePositionAfter(intent, protectedResult);
    }
    return this.reconcilePositionAfter(intent, result);
  }

  async reconcileUnknown(
    clientOrderId: string,
    symbol: string,
  ): Promise<FuturesOrderResult> {
    const pending = await this.reconciliationStore.loadUnknown(clientOrderId);
    if (!pending || pending.intent.symbol !== symbol) {
      throw new Error("Only a matching persisted UNKNOWN outcome may be reconciled.");
    }

    const evidence = await this.userDataEvidence?.find(
      pending.kind,
      pending.queryClientId,
    );
    const freshEvidence = evidence
      && evidence.kind === pending.kind
      && evidence.clientOrderId === pending.queryClientId
      && evidence.observedAt >= pending.recordedAt
      ? evidence
      : undefined;

    if (pending.kind === "order") {
      let orderResult = freshEvidence?.kind === "order"
        ? freshEvidence.result
        : undefined;
      if (!orderResult || orderResult.status === "UNKNOWN") {
        try {
          // One explicit query only; the original market order is never resubmitted.
          orderResult = await this.transport.queryOrder(symbol, pending.queryClientId);
        } catch (error) {
          if (isRateLimitError(error)) await this.pause("rate_limit");
          return { clientOrderId, status: "UNKNOWN" };
        }
      }
      if (!orderResult || orderResult.status === "UNKNOWN") {
        return { clientOrderId, status: "UNKNOWN" };
      }
      if (!["ACCEPTED", "PARTIALLY_FILLED", "FILLED"].includes(orderResult.status)
        || pending.intent.reduceOnly) {
        await this.reconciliationStore.markResolved(clientOrderId, orderResult);
        return pending.intent.reduceOnly
          ? this.reconcilePositionAfter(pending.intent, orderResult)
          : orderResult;
      }
      const protectedResult = await this.installAndVerifyProtection(
        pending.intent,
        orderResult,
      );
      if (protectedResult.protectionStatus === "ACTIVE"
        || protectedResult.protectionStatus === "TRIGGERED"
        || protectedResult.protectionStatus === "FILLED") {
        await this.reconciliationStore.markResolved(clientOrderId, protectedResult);
        return this.reconcilePositionAfter(pending.intent, protectedResult);
      }
      return protectedResult;
    }

    let protection = freshEvidence?.kind === "protection"
      ? freshEvidence.result
      : undefined;
    if (!protection || protection.status === "UNKNOWN") {
      try {
        // One explicit algo query only; the protection order is never resubmitted.
        protection = await this.transport.queryProtectiveStop(pending.queryClientId);
      } catch (error) {
        if (isRateLimitError(error)) await this.pause("rate_limit");
        return {
          clientOrderId,
          status: "UNKNOWN",
          protectionClientOrderId: pending.queryClientId,
          protectionStatus: "UNKNOWN",
        };
      }
    }
    const expected = this.protectionRequest(pending.intent);
    if (!verifiedProtection(protection, expected)) {
      await this.pause("protection_orders");
      return {
        clientOrderId,
        status: "UNKNOWN",
        protectionClientOrderId: pending.queryClientId,
        protectionStatus: protection?.status ?? "UNKNOWN",
        message: "Protective stop remains unverified; new entries are paused.",
      };
    }
    const result: FuturesOrderResult = {
      ...(pending.knownOrderResult ?? {
        clientOrderId,
        status: "FILLED" as const,
      }),
      clientOrderId,
      protectionClientOrderId: pending.queryClientId,
      protectionStatus: protection!.status,
    };
    await this.reconciliationStore.markResolved(clientOrderId, result);
    return this.reconcilePositionAfter(pending.intent, result);
  }

  private async installAndVerifyProtection(
    intent: StoredExecutionIntent,
    orderResult: FuturesOrderResult,
  ): Promise<FuturesOrderResult> {
    if (orderResult.status === "PARTIALLY_FILLED"
      && (!Number.isFinite(orderResult.executedQuantity)
        || (orderResult.executedQuantity ?? 0) <= 0)) {
      await this.pause("protection_orders");
      return {
        ...orderResult,
        protectionStatus: "REJECTED",
        message: "Partial fill quantity is unavailable; protective stop was not submitted and new entries are paused.",
      };
    }
    const protectedQuantity = orderResult.executedQuantity && orderResult.executedQuantity > 0
      ? Math.min(intent.quantity, orderResult.executedQuantity)
      : intent.quantity;
    const protectionIntent = protectedQuantity === intent.quantity
      ? intent
      : { ...intent, quantity: protectedQuantity };
    const request = this.protectionRequest(protectionIntent);
    try {
      // Protection mutation is invoked once and never automatically retried.
      await this.transport.installProtectiveStop(request);
    } catch (error) {
      if (isRateLimitError(error)) await this.pause("rate_limit");
      await this.pause("protection_orders");
      await this.persistUnknown(
        protectionIntent,
        "protection",
        request.clientAlgoId,
        orderResult,
      );
      return {
        ...orderResult,
        status: "UNKNOWN",
        protectionClientOrderId: request.clientAlgoId,
        protectionStatus: "UNKNOWN",
        message: "Entry may be open but protective stop outcome is UNKNOWN; new entries are paused.",
      };
    }

    let verification: BinanceProtectionResult | undefined;
    try {
      // Immediate installation verification is exactly one query.
      verification = await this.transport.queryProtectiveStop(request.clientAlgoId);
    } catch (error) {
      if (isRateLimitError(error)) await this.pause("rate_limit");
      await this.pause("protection_orders");
      await this.persistUnknown(
        protectionIntent,
        "protection",
        request.clientAlgoId,
        orderResult,
      );
      return {
        ...orderResult,
        status: "UNKNOWN",
        protectionClientOrderId: request.clientAlgoId,
        protectionStatus: "UNKNOWN",
        message: "Protective stop verification is UNKNOWN; new entries are paused.",
      };
    }
    if (!verifiedProtection(verification, request)) {
      await this.pause("protection_orders");
      if (!verification || verification.status === "UNKNOWN") {
        await this.persistUnknown(
          protectionIntent,
          "protection",
          request.clientAlgoId,
          orderResult,
        );
      }
      return {
        ...orderResult,
        ...(!verification || verification.status === "UNKNOWN"
          ? { status: "UNKNOWN" as const }
          : {}),
        protectionClientOrderId: request.clientAlgoId,
        protectionStatus: verification?.status ?? "UNKNOWN",
        message: "Protective stop installation failed verification; new entries are paused.",
      };
    }
    return {
      ...orderResult,
      protectionClientOrderId: request.clientAlgoId,
      protectionStatus: verification!.status,
    };
  }

  private protectionRequest(intent: StoredExecutionIntent): BinanceProtectiveStopRequest {
    if (intent.protectiveStopPrice === undefined) {
      throw new Error("Persisted entry intent is missing its protective stop.");
    }
    return {
      symbol: intent.symbol,
      side: intent.side === "BUY" ? "SELL" : "BUY",
      quantity: intent.quantity,
      triggerPrice: intent.protectiveStopPrice,
      clientAlgoId: protectionClientId(intent.clientOrderId),
      positionSide: "BOTH",
      reduceOnly: true,
    };
  }

  private async reconcilePositionAfter(
    intent: StoredExecutionIntent,
    result: FuturesOrderResult,
  ): Promise<FuturesOrderResult> {
    if (!["ACCEPTED", "PARTIALLY_FILLED", "FILLED"].includes(result.status)) return result;
    try {
      const position = await this.transport.queryPosition(intent.symbol);
      if (positionMatchesAfter(intent, position)) return result;
    } catch (error) {
      if (isRateLimitError(error)) await this.pause("rate_limit");
    }
    await this.pause("position_mismatch");
    return {
      ...result,
      message: [
        result.message,
        "Account position failed post-order reconciliation; new entries are paused.",
      ].filter(Boolean).join(" "),
    };
  }

  private async persistUnknown(
    intent: StoredExecutionIntent,
    kind: "order" | "protection",
    queryClientId: string,
    knownOrderResult?: FuturesOrderResult,
  ): Promise<void> {
    try {
      await this.reconciliationStore.recordUnknown({
        version: 1,
        intent,
        kind,
        queryClientId,
        recordedAt: this.currentTime(),
        ...(knownOrderResult ? { knownOrderResult } : {}),
      });
    } catch {
      await this.pause("durable_reconciliation");
      throw new Error("UNKNOWN execution outcome could not be durably persisted.");
    }
  }

  private async pause(reason: string): Promise<void> {
    this.entryPauses.add(reason);
    try {
      await this.supervisor?.pauseEntries(reason);
    } catch {
      // The local fail-closed latch remains set even if external supervision fails.
    }
  }

  protected currentTime(): number {
    return this.clock();
  }

  protected verifiedIpRestriction(
    evidence: IpRestrictionQualification | undefined,
  ): boolean {
    if (!evidence || !this.ipRestrictionVerifier) return false;
    try {
      return this.ipRestrictionVerifier.verify(evidence);
    } catch {
      return false;
    }
  }
}

export class BinanceTestnetExecution extends GuardedBinanceExecution {
  readonly mode = "testnet" as const;
  protected maximumLeverage(): number { return 10; }
  protected blockersFor(request?: FuturesOrderRequest): string[] {
    return this.commonBlockers(request);
  }
}

export class BinanceLiveExecution extends GuardedBinanceExecution {
  readonly mode = "live" as const;
  protected maximumLeverage(): number { return 10; }

  protected blockersFor(request?: FuturesOrderRequest): string[] {
    const now = this.currentTime();
    const trading = this.gates.tradingPermissionEvidence;
    const ip = this.gates.ipRestrictionQualification;
    const testnet = this.gates.testnetQualification;
    const blockers = [
      ...this.commonBlockers(request),
      ...(!evidenceIsFresh(trading, now) || trading.tradingAllowed !== true
        || trading.source !== "binance_signed_account"
        ? ["trading_permission_evidence"]
        : []),
      ...(!evidenceIsFresh(ip, now) || ip.restricted !== true
        || !ip.attestationId.trim() || !ip.signedBy.trim()
        || !ip.detachedSignature.trim() || !this.verifiedIpRestriction(ip)
        ? ["ip_restriction_qualification"]
        : []),
      ...(!evidenceIsFresh(testnet, now) || testnet.succeeded !== true
        || !testnet.qualificationId.trim()
        ? ["testnet_qualification"]
        : []),
      ...(!this.gates.championModel ? ["champion_model"] : []),
      ...(testnet && this.gates.championModel
        && testnet.modelLane !== this.gates.championModel
        ? ["testnet_model_mismatch"]
        : []),
    ];
    if (request) {
      if (request.modelLane !== this.gates.championModel) blockers.push("model_mismatch");
      const expected = `LIVE:${request.runId}:${request.symbol}`;
      if (request.typedConfirmation !== expected) blockers.push("typed_confirmation");
    }
    return [...new Set(blockers)];
  }
}

export function createConfiguredFuturesExecution(config: {
  mode?: FuturesExecutionMode;
} = {}): FuturesExecution {
  if ((config.mode ?? "paper") !== "paper") {
    throw new Error("This deployment is paper-only; Binance order transports are not configured.");
  }
  return new PaperExecution();
}
