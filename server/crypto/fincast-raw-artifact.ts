import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJsonExceedsByteLimit } from "../json-byte-limit.js";

const RAW_INPUT_SCHEMA = "fincast-raw-input/v1" as const;
const RAW_CONTEXT_BARS = 512 as const;
const RAW_HORIZONS = [5, 15, 30, 60] as const;
const MAXIMUM_ROWS = 10_000_000;
const MAXIMUM_METADATA_BYTES = 1 << 20;
const FORBIDDEN_PRICE_KEY = /^(?:open|high|low|close|volume|amount|price|quotevolume)$/i;

export type FinCastRawInputCadence = 15 | 30 | 60;

export type FinCastRawInputRow = {
  instrumentKey: string;
  origin: string;
  futureTimestamps: readonly string[];
  closes: readonly number[];
  metadata?: Record<string, unknown>;
};

export type FinCastRawInputManifest = {
  schema_version: "fincast-raw-input/v1";
  cadence_seconds: FinCastRawInputCadence;
  horizon_minutes: [5, 15, 30, 60];
  row_count: number;
  row_order: "row_id_ascending";
  context_bars: 512;
  model_seed: number;
  files: {
    contexts: {
      name: "contexts.f32";
      size_bytes: number;
      sha256: string;
    };
    origins: {
      name: "origins.jsonl";
      size_bytes: number;
      sha256: string;
    };
  };
  metadata: Record<string, unknown>;
};

export type FinCastRawInputArtifact = {
  directory: string;
  manifestPath: string;
  manifest: FinCastRawInputManifest;
  manifestSha256: string;
};

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function canonicalTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${label} must be an explicit canonical UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} is invalid.`);
  }
  const canonical = new Date(parsed).toISOString();
  if (canonical !== (value.endsWith("Z") && !value.includes(".")
    ? value.replace(/Z$/, ".000Z")
    : value)) {
    throw new Error(`${label} is not canonical.`);
  }
  return canonical;
}

function validateMetadata(value: unknown, path = "metadata"): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateMetadata(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain only finite JSON values.`);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!key || key.length > 128 || FORBIDDEN_PRICE_KEY.test(key)) {
      throw new Error(`${path} contains a forbidden or invalid price field.`);
    }
    validateMetadata(nested, `${path}.${key}`);
  }
}

async function prepareOutputDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("FinCast raw artifact directory must be an absolute normalized path.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("FinCast raw artifact directory must not traverse symlinks.");
  }
  if ((await readdir(directory)).length !== 0) {
    throw new Error("FinCast raw artifact directory must be empty.");
  }
  return directory;
}

async function atomicFile(
  path: string,
  payload: Uint8Array,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function contextPayload(rows: readonly FinCastRawInputRow[]): Buffer {
  const payload = Buffer.allocUnsafe(rows.length * RAW_CONTEXT_BARS * Float32Array.BYTES_PER_ELEMENT);
  let offset = 0;
  for (const [rowId, row] of rows.entries()) {
    if (row.closes.length !== RAW_CONTEXT_BARS) {
      throw new Error(`FinCast raw row ${rowId} must contain exactly 512 closes.`);
    }
    for (const close of row.closes) {
      if (!Number.isFinite(close) || close <= 0) {
        throw new Error(`FinCast raw row ${rowId} contains an invalid close.`);
      }
      payload.writeFloatLE(close, offset);
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
  }
  return payload;
}

function originsPayload(rows: readonly FinCastRawInputRow[]): Buffer {
  const lines = rows.map((row, rowId) => {
    if (
      !row.instrumentKey
      || row.instrumentKey.length > 256
      || row.futureTimestamps.length < 60
    ) {
      throw new Error(`FinCast raw row ${rowId} has invalid non-price metadata.`);
    }
    const origin = canonicalTimestamp(row.origin, `row ${rowId} origin`);
    const originMs = Date.parse(origin);
    let previous = originMs;
    const futureTimestamps = row.futureTimestamps.map((timestamp, index) => {
      const canonical = canonicalTimestamp(
        timestamp,
        `row ${rowId} future timestamp ${index}`,
      );
      const current = Date.parse(canonical);
      if (current <= previous) {
        throw new Error(`FinCast raw row ${rowId} future timestamps must increase.`);
      }
      previous = current;
      return canonical;
    });
    const metadata = row.metadata ?? {};
    validateMetadata(metadata, `row ${rowId} metadata`);
    return JSON.stringify({
      row_id: rowId,
      instrument_key: row.instrumentKey,
      origin,
      future_timestamps: futureTimestamps,
      metadata,
    });
  });
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export async function writeFinCastRawInputArtifact(input: {
  directory: string;
  cadenceSeconds: FinCastRawInputCadence;
  modelSeed: number;
  rows: readonly FinCastRawInputRow[];
  metadata?: Record<string, unknown>;
}): Promise<FinCastRawInputArtifact> {
  if (
    !Number.isSafeInteger(input.modelSeed)
    || input.modelSeed < 0
    || input.modelSeed > Number.MAX_SAFE_INTEGER
    || input.rows.length < 1
    || input.rows.length > MAXIMUM_ROWS
  ) {
    throw new Error("FinCast raw artifact row count or model seed is invalid.");
  }
  const metadata = input.metadata ?? {};
  validateMetadata(metadata);
  if (canonicalJsonExceedsByteLimit(metadata, MAXIMUM_METADATA_BYTES)) {
    throw new Error("FinCast raw artifact metadata exceeds its size bound.");
  }
  const directory = await prepareOutputDirectory(input.directory);
  const contexts = contextPayload(input.rows);
  const origins = originsPayload(input.rows);
  const manifest: FinCastRawInputManifest = {
    schema_version: RAW_INPUT_SCHEMA,
    cadence_seconds: input.cadenceSeconds,
    horizon_minutes: [...RAW_HORIZONS],
    row_count: input.rows.length,
    row_order: "row_id_ascending",
    context_bars: RAW_CONTEXT_BARS,
    model_seed: input.modelSeed,
    files: {
      contexts: {
        name: "contexts.f32",
        size_bytes: contexts.byteLength,
        sha256: sha256(contexts),
      },
      origins: {
        name: "origins.jsonl",
        size_bytes: origins.byteLength,
        sha256: sha256(origins),
      },
    },
    metadata,
  };
  const manifestPayload = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const contextsPath = join(directory, "contexts.f32");
  const originsPath = join(directory, "origins.jsonl");
  const manifestPath = join(directory, "manifest.json");
  await atomicFile(contextsPath, contexts);
  await atomicFile(originsPath, origins);
  await atomicFile(manifestPath, manifestPayload);
  return {
    directory,
    manifestPath,
    manifest,
    manifestSha256: sha256(manifestPayload),
  };
}
