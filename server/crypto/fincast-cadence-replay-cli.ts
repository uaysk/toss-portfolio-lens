import { randomUUID } from "node:crypto";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCryptoAiConfig } from "../env.js";
import { AiComputeClient } from "../worker/ai-client.js";
import { OfficialBinanceUsdmRestMarketData } from "./binance-market-data.js";
import {
  FinCastCadenceComparisonReplay,
  type FinCastCadenceComparisonResult,
} from "./fincast-cadence-replay.js";

const DEFAULT_DEADLINE_MS = 4 * 60 * 60_000;
const MAXIMUM_DEADLINE_MS = 24 * 60 * 60_000;
const OUTPUT_SCHEMA = "crypto-fincast-cadence-comparison/v1";

export type FinCastCadenceReplayCliArguments = {
  symbol: string;
  output: string;
  endExclusive: number;
  deadlineMs: number;
};

function usage(): string {
  return [
    "usage: node fincast-cadence-replay-cli.js",
    "--symbol <USDT perpetual symbol>",
    "--output <absolute JSON path>",
    "--end-exclusive <UTC minute RFC3339>",
    "[--deadline-ms <1..86400000>]",
  ].join(" ");
}

function requiredValue(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value. ${usage()}`);
  return value;
}

function parseEndExclusive(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)) {
    throw new Error(`--end-exclusive must be an exact UTC minute. ${usage()}`);
  }
  const parsed = Date.parse(value);
  const canonical = value.endsWith(":00Z")
    ? value.replace(/:00Z$/, ":00.000Z")
    : value;
  if (
    !Number.isSafeInteger(parsed)
    || parsed <= 0
    || parsed % 60_000 !== 0
    || new Date(parsed).toISOString() !== canonical
  ) {
    throw new Error(`--end-exclusive must be an exact UTC minute. ${usage()}`);
  }
  return parsed;
}

export function parseFinCastCadenceReplayCliArguments(
  arguments_: readonly string[],
): FinCastCadenceReplayCliArguments {
  let symbol: string | undefined;
  let output: string | undefined;
  let endExclusive: number | undefined;
  let deadlineMs = DEFAULT_DEADLINE_MS;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--symbol") {
      symbol = requiredValue(arguments_, index, "--symbol").toUpperCase();
      index += 1;
    } else if (argument === "--output") {
      output = requiredValue(arguments_, index, "--output");
      index += 1;
    } else if (argument === "--end-exclusive") {
      endExclusive = parseEndExclusive(requiredValue(arguments_, index, "--end-exclusive"));
      index += 1;
    } else if (argument === "--deadline-ms") {
      const raw = requiredValue(arguments_, index, "--deadline-ms");
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAXIMUM_DEADLINE_MS) {
        throw new Error(`--deadline-ms must be an integer between 1 and ${MAXIMUM_DEADLINE_MS}.`);
      }
      deadlineMs = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}. ${usage()}`);
    }
  }
  if (!symbol || !/^[A-Z0-9]{2,32}$/.test(symbol) || !symbol.endsWith("USDT")) {
    throw new Error(`--symbol must identify a Binance USDT contract. ${usage()}`);
  }
  if (!output || !isAbsolute(output)) {
    throw new Error(`--output must be an absolute path. ${usage()}`);
  }
  if (endExclusive === undefined) {
    throw new Error(`--end-exclusive is required. ${usage()}`);
  }
  return {
    symbol,
    output: resolve(output),
    endExclusive,
    deadlineMs,
  };
}

export async function writeFinCastCadenceReplayResult(
  outputPath: string,
  result: FinCastCadenceComparisonResult,
): Promise<void> {
  if (!isAbsolute(outputPath) || result.schemaVersion !== OUTPUT_SCHEMA) {
    throw new Error("FinCast cadence replay output path or schema is invalid.");
  }
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function run(): Promise<void> {
  const arguments_ = parseFinCastCadenceReplayCliArguments(process.argv.slice(2));
  const config = readCryptoAiConfig();
  if (!config.fincast) {
    throw new Error("AI_FINCAST_COMPUTE_URL is required for a FinCast cadence replay.");
  }
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`FinCast cadence replay stopped by ${signal}.`));
    }
  };
  const onSigint = () => abort("SIGINT");
  const onSigterm = () => abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const client = new AiComputeClient({
    ...config.fincast,
    timeoutMs: arguments_.deadlineMs,
    maximumInFlight: 1,
  });
  client.start();
  try {
    const replay = new FinCastCadenceComparisonReplay({
      rest: new OfficialBinanceUsdmRestMarketData(30_000),
      client,
      deadlineMs: arguments_.deadlineMs,
    });
    const result = await replay.run({
      symbol: arguments_.symbol,
      endExclusive: arguments_.endExclusive,
      deadlineMs: arguments_.deadlineMs,
      signal: controller.signal,
      costAssumptions: {
        commission_bps_per_side: 4,
        tax_bps_on_exit: 0,
        spread_bps_round_trip: 2,
        slippage_bps_per_side: 1,
      },
    });
    await writeFinCastCadenceReplayResult(arguments_.output, result);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: result.schemaVersion,
      symbol: result.symbol,
      originStartAt: result.window.originStartAt,
      originEndExclusiveAt: result.window.originEndExclusiveAt,
      outcome: result.comparison.outcome,
      output: arguments_.output,
    })}\n`);
  } finally {
    client.close();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  run().catch((error: unknown) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 500)
      : "FinCast cadence replay failed.";
    process.stderr.write(`fincast-cadence-replay-error: ${message}\n`);
    process.exitCode = 1;
  });
}
