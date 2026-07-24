export type KnownAdvancedRunKind =
  | "backtest"
  | "optimization"
  | "walk_forward"
  | "stress_test"
  | "weight_sensitivity"
  | "start_date_sensitivity"
  | "rebalance_sensitivity"
  | "cash_flow_sensitivity"
  | "monte_carlo"
  | "outlook"
  | "technical_analysis"
  | "technical_strategy"
  | "scalping_prediction_evaluation"
  | "scalping_analysis"
  | "ai_trading_simulation"
  | "exposure_analysis"
  | "pareto_frontier"
  | "research_report";

export type AdvancedRunKind =
  | KnownAdvancedRunKind
  | "advanced"
  | (string & Record<never, never>);

export type AdvancedRunStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "completed"
  | "failed";

export type AdvancedRunArtifact = {
  type: string;
  rowCount: number;
  byteCount: number;
};

export type AdvancedRunError = {
  code?: string;
  message?: string;
  retryable?: boolean;
};

/**
 * Run summary and result bodies are persisted, kind-specific JSON. Callers must
 * narrow them at the API boundary before using their fields.
 */
export type PersistedRunPayload = unknown;

type AdvancedRunBase = {
  runId: string;
  kind: AdvancedRunKind;
  progress: number;
  completedCandidates: number;
  totalCandidates: number;
  currentValidationWindow?: string;
  summary?: PersistedRunPayload;
  warnings: string[];
  artifacts?: AdvancedRunArtifact[];
};

type ActiveAdvancedRunStatus = "queued" | "running" | "cancel_requested";

export type ActiveAdvancedRunSnapshot = {
  [Status in ActiveAdvancedRunStatus]: AdvancedRunBase & {
    status: Status;
    result?: undefined;
    resultExternalized?: undefined;
    error?: undefined;
  };
}[ActiveAdvancedRunStatus];

export type CompletedAdvancedRunSnapshot = AdvancedRunBase & {
  status: "completed";
  result?: PersistedRunPayload;
  resultExternalized?: boolean;
  error?: undefined;
};

type UnsuccessfulAdvancedRunStatus = "cancelled" | "failed";

export type UnsuccessfulAdvancedRunSnapshot = {
  [Status in UnsuccessfulAdvancedRunStatus]: AdvancedRunBase & {
    status: Status;
    result?: undefined;
    resultExternalized?: undefined;
    error?: AdvancedRunError;
  };
}[UnsuccessfulAdvancedRunStatus];

export type AdvancedRunSnapshot =
  | ActiveAdvancedRunSnapshot
  | CompletedAdvancedRunSnapshot
  | UnsuccessfulAdvancedRunSnapshot;
