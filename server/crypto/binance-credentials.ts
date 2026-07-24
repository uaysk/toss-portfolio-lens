import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DerivativesTradingUsdsFutures,
} from "@binance/derivatives-trading-usds-futures";

export type BinanceCredentialSource =
  | "unconfigured"
  | "environment"
  | "file_override"
  | "mixed";

export class BinanceServerCredentials {
  readonly #apiKey: string;
  readonly #apiSecret: string;

  constructor(apiKey: string, apiSecret: string) {
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
  }

  use<T>(consumer: (apiKey: string, apiSecret: string) => T): T {
    return consumer(this.#apiKey, this.#apiSecret);
  }

  toJSON() {
    return { configured: true };
  }
}

export type BinanceCredentialLoadResult = {
  configured: boolean;
  source: BinanceCredentialSource;
  error?: "invalid_file_path" | "file_unreadable" | "invalid_value" | "partial_configuration";
  credentials?: BinanceServerCredentials;
};

type SecretEnvironment = Partial<Record<
  | "BINANCE_API_KEY"
  | "BINANCE_SECRET_KEY"
  | "BINANCE_API_KEY_FILE"
  | "BINANCE_SECRET_KEY_FILE",
  string
>>;

function validSecret(value: string): boolean {
  return /^[\x21-\x7e]{16,512}$/.test(value);
}

export function loadBinanceServerCredentials(
  environment: SecretEnvironment,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): BinanceCredentialLoadResult {
  const apiFile = environment.BINANCE_API_KEY_FILE?.trim();
  const secretFile = environment.BINANCE_SECRET_KEY_FILE?.trim();
  if ((apiFile && !isAbsolute(apiFile)) || (secretFile && !isAbsolute(secretFile))) {
    return { configured: false, source: "file_override", error: "invalid_file_path" };
  }
  let apiKey = environment.BINANCE_API_KEY?.trim() ?? "";
  let apiSecret = environment.BINANCE_SECRET_KEY?.trim() ?? "";
  try {
    if (apiFile) apiKey = readFile(apiFile).trim();
    if (secretFile) apiSecret = readFile(secretFile).trim();
  } catch {
    return { configured: false, source: "file_override", error: "file_unreadable" };
  }
  const source: BinanceCredentialSource = apiFile || secretFile
    ? apiFile && secretFile ? "file_override" : "mixed"
    : apiKey || apiSecret ? "environment" : "unconfigured";
  if (!apiKey && !apiSecret) return { configured: false, source: "unconfigured" };
  if (!apiKey || !apiSecret) {
    return { configured: false, source, error: "partial_configuration" };
  }
  if (!validSecret(apiKey) || !validSecret(apiSecret)) {
    return { configured: false, source, error: "invalid_value" };
  }
  return {
    configured: true,
    source,
    credentials: new BinanceServerCredentials(apiKey, apiSecret),
  };
}

type SignedReadResponse = { data(): unknown | Promise<unknown> };
export type BinanceSignedReadRestApi = {
  accountInformationV3(input?: unknown): Promise<SignedReadResponse>;
};

export type BinanceSignedReadStatus = {
  configured: boolean;
  signedReadSucceeded: boolean;
  state: "unconfigured" | "ok" | "unauthorized" | "rate_limited" | "unavailable";
};

function probeFailureState(
  error: unknown,
): Exclude<BinanceSignedReadStatus["state"], "unconfigured" | "ok"> {
  if (!error || typeof error !== "object") return "unavailable";
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const status = Number(value.status ?? value.statusCode ?? value.response?.status);
  if (status === 401 || status === 403 || Number(value.code) === -2015) return "unauthorized";
  if (status === 418 || status === 429) return "rate_limited";
  return "unavailable";
}

export class BinanceSignedReadProbe {
  private readonly rest?: BinanceSignedReadRestApi;

  constructor(input: {
    credentials?: BinanceServerCredentials;
    environment?: "testnet" | "live";
    timeoutMs?: number;
    rest?: BinanceSignedReadRestApi;
  }) {
    if (!input.credentials) return;
    if (input.rest) {
      this.rest = input.rest;
      return;
    }
    this.rest = input.credentials.use((apiKey, apiSecret) => {
      const client = new DerivativesTradingUsdsFutures({
        configurationRestAPI: {
          apiKey,
          apiSecret,
          basePath: input.environment === "testnet"
            ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
            : DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
          timeout: input.timeoutMs ?? 5_000,
          retries: 0,
        },
      });
      return client.restAPI;
    });
  }

  async probe(): Promise<BinanceSignedReadStatus> {
    if (!this.rest) {
      return {
        configured: false,
        signedReadSucceeded: false,
        state: "unconfigured",
      };
    }
    try {
      // Consume and immediately discard the signed account response. Balances,
      // positions, signatures, and credential material never enter status.
      await (await this.rest.accountInformationV3()).data();
      return { configured: true, signedReadSucceeded: true, state: "ok" };
    } catch (error) {
      return {
        configured: true,
        signedReadSucceeded: false,
        state: probeFailureState(error),
      };
    }
  }
}
