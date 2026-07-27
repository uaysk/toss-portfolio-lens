import { randomUUID } from "node:crypto";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCryptoAiConfig } from "../env.js";
import { AiComputeClient } from "../worker/ai-client.js";
import { OfficialBinanceUsdmRestMarketData } from "./binance-market-data.js";
import {
  CryptoModelComparisonReplay,
  type CryptoModelReplayResult,
  type KronosReplayLoaderProfile,
} from "./crypto-model-replay.js";

const DEFAULT_DEADLINE_MS = 12 * 60 * 60_000;
const MAXIMUM_DEADLINE_MS = 24 * 60 * 60_000;
const DEFAULT_DURATION_HOURS = 7 * 24;
const MAXIMUM_DURATION_HOURS = 5 * 7 * 24;
const OUTPUT_SCHEMA = "crypto-model-comparison-replay/v1";

export type CryptoReplayCliArguments = {
  symbol: string;
  output: string;
  deadlineMs: number;
  durationHours: number;
  endExclusive?: number;
  kronosLoaderProfile: KronosReplayLoaderProfile;
};

function usage(): string {
  return [
    "usage: node crypto-model-replay-cli.js",
    "--symbol <USDT perpetual symbol>",
    "--output <absolute JSON path>",
    "[--deadline-ms <1..86400000>]",
    "[--duration-hours <1..840>]",
    "[--end-exclusive <UTC minute RFC3339>]",
    "[--kronos-loader-profile <base|kv_cache_v1>]",
  ].join(" ");
}

function requiredValue(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value. ${usage()}`);
  return value;
}

function exactUtcMinute(value: string, name: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)) {
    throw new Error(`${name} must be an exact UTC minute. ${usage()}`);
  }
  const parsed = Date.parse(value);
  const canonical = value.endsWith(":00Z")
    ? value.replace(/:00Z$/, ":00.000Z")
    : value;
  if (!Number.isSafeInteger(parsed)
    || parsed <= 0
    || parsed % 60_000 !== 0
    || new Date(parsed).toISOString() !== canonical) {
    throw new Error(`${name} must be an exact UTC minute. ${usage()}`);
  }
  return parsed;
}

export function parseCryptoReplayCliArguments(
  arguments_: readonly string[],
): CryptoReplayCliArguments {
  let symbol: string | undefined;
  let output: string | undefined;
  let deadlineMs = DEFAULT_DEADLINE_MS;
  let durationHours = DEFAULT_DURATION_HOURS;
  let endExclusive: number | undefined;
  let kronosLoaderProfile: KronosReplayLoaderProfile = "base";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--symbol") {
      symbol = requiredValue(arguments_, index, "--symbol").toUpperCase();
      index += 1;
    } else if (argument === "--output") {
      output = requiredValue(arguments_, index, "--output");
      index += 1;
    } else if (argument === "--deadline-ms") {
      const raw = requiredValue(arguments_, index, "--deadline-ms");
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAXIMUM_DEADLINE_MS) {
        throw new Error(`--deadline-ms must be an integer between 1 and ${MAXIMUM_DEADLINE_MS}.`);
      }
      deadlineMs = parsed;
      index += 1;
    } else if (argument === "--duration-hours") {
      const raw = requiredValue(arguments_, index, "--duration-hours");
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAXIMUM_DURATION_HOURS) {
        throw new Error(
          `--duration-hours must be an integer between 1 and ${MAXIMUM_DURATION_HOURS}.`,
        );
      }
      durationHours = parsed;
      index += 1;
    } else if (argument === "--end-exclusive") {
      endExclusive = exactUtcMinute(
        requiredValue(arguments_, index, "--end-exclusive"),
        "--end-exclusive",
      );
      index += 1;
    } else if (argument === "--kronos-loader-profile") {
      const value = requiredValue(arguments_, index, "--kronos-loader-profile");
      if (value !== "base" && value !== "kv_cache_v1") {
        throw new Error("--kronos-loader-profile must be base or kv_cache_v1.");
      }
      kronosLoaderProfile = value;
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
  return {
    symbol,
    output: resolve(output),
    deadlineMs,
    durationHours,
    ...(endExclusive === undefined ? {} : { endExclusive }),
    kronosLoaderProfile,
  };
}

export async function writeReplayResult(
  outputPath: string,
  result: CryptoModelReplayResult,
): Promise<void> {
  if (!isAbsolute(outputPath) || result.schemaVersion !== OUTPUT_SCHEMA) {
    throw new Error("Replay output path or schema is invalid.");
  }
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A hard link provides an atomic no-clobber publish on the same data
    // volume. Existing evidence is never overwritten by a repeated run.
    await link(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function run(): Promise<void> {
  const arguments_ = parseCryptoReplayCliArguments(process.argv.slice(2));
  const config = readCryptoAiConfig();
  if (!config.kronos) {
    throw new Error("AI_KRONOS_COMPUTE_URL is required for a legacy two-lane replay.");
  }
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) controller.abort(new Error(`Replay stopped by ${signal}.`));
  };
  const onSigint = () => abort("SIGINT");
  const onSigterm = () => abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const kronos = new AiComputeClient({
    ...config.kronos,
    timeoutMs: arguments_.deadlineMs,
    maximumInFlight: 1,
  });
  const fincast = new AiComputeClient({
    ...config.fincast,
    timeoutMs: arguments_.deadlineMs,
    maximumInFlight: 1,
  });
  kronos.start();
  fincast.start();
  try {
    const replay = new CryptoModelComparisonReplay({
      rest: new OfficialBinanceUsdmRestMarketData(30_000),
      lanes: { kronos_base: kronos, fincast },
      deadlineMs: arguments_.deadlineMs,
    });
    const result = await replay.run({
      symbol: arguments_.symbol,
      deadlineMs: arguments_.deadlineMs,
      signal: controller.signal,
      durationHours: arguments_.durationHours,
      ...(arguments_.endExclusive === undefined
        ? {}
        : { endExclusive: arguments_.endExclusive }),
      kronosLoaderProfile: arguments_.kronosLoaderProfile,
      costAssumptions: {
        commission_bps_per_side: 4,
        tax_bps_on_exit: 0,
        spread_bps_round_trip: 2,
        slippage_bps_per_side: 1,
      },
    });
    await writeReplayResult(arguments_.output, result);
    process.stdout.write(JSON.stringify({
      schemaVersion: result.schemaVersion,
      symbol: result.symbol,
      outcome: result.comparison.outcome,
      output: arguments_.output,
    }) + "\n");
  } finally {
    kronos.close();
    fincast.close();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  run().catch((error: unknown) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 500)
      : "Crypto model replay failed.";
    process.stderr.write(`crypto-model-replay-error: ${message}\n`);
    process.exitCode = 1;
  });
}
