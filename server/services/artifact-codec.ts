import { createHash } from "node:crypto";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { canonicalJson } from "../worker/canonical-json.js";

export const ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES = 1024 * 1024;

const ARTIFACT_CODEC_WORKER_MARKER = "toss-portfolio-lens-artifact-codec/v1";

export type EncodedArtifact = {
  contentJson: string;
  checksum: string;
  byteCount: number;
  offloaded: boolean;
};

type ArtifactCodecOptions = {
  offloadThresholdBytes?: number;
  workerIdleMs?: number;
};

type SizeCounter = {
  bytes: number;
  threshold: number;
  ancestors: WeakSet<object>;
};

type CodecWorkerRequest = {
  id: number;
  value: unknown;
};

type CodecWorkerResponse = {
  id: number;
  result?: Omit<EncodedArtifact, "offloaded">;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

type PendingEncoding = {
  resolve: (value: EncodedArtifact) => void;
  reject: (reason: unknown) => void;
};

function addBytes(counter: SizeCounter, byteCount: number): boolean {
  counter.bytes += byteCount;
  return counter.bytes >= counter.threshold;
}

function countJsonString(value: string, counter: SizeCounter): boolean {
  if (addBytes(counter, 2)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      if (addBytes(counter, 2)) return true;
      continue;
    }
    if (code < 0x20) {
      const escapedBytes = code === 0x08
        || code === 0x09
        || code === 0x0a
        || code === 0x0c
        || code === 0x0d
        ? 2
        : 6;
      if (addBytes(counter, escapedBytes)) return true;
      continue;
    }
    if (code < 0x80) {
      if (addBytes(counter, 1)) return true;
      continue;
    }
    if (code < 0x800) {
      if (addBytes(counter, 2)) return true;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        if (addBytes(counter, 4)) return true;
      } else if (addBytes(counter, 6)) {
        return true;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (addBytes(counter, 6)) return true;
      continue;
    }
    if (addBytes(counter, 3)) return true;
  }
  return false;
}

function countCanonicalJson(value: unknown, counter: SizeCounter, path = "$"): boolean {
  if (value === null) return addBytes(counter, 4);
  if (typeof value === "string") return countJsonString(value, counter);
  if (typeof value === "boolean") return addBytes(counter, value ? 4 : 5);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`worker payload의 ${path} 값은 유한한 숫자여야 합니다.`);
    return addBytes(counter, String(Object.is(value, -0) ? 0 : value).length);
  }
  if (Array.isArray(value)) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      if (addBytes(counter, 1)) return true;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && addBytes(counter, 1)) return true;
        if (countCanonicalJson(value[index], counter, `${path}[${index}]`)) return true;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  if (value instanceof Map) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      const normalized = new Map<string, unknown>();
      for (const [key, item] of value.entries()) normalized.set(String(key), item);
      const entries = [...normalized.entries()];
      if (addBytes(counter, 1)) return true;
      for (let index = 0; index < entries.length; index += 1) {
        const [key, item] = entries[index]!;
        if (index > 0 && addBytes(counter, 1)) return true;
        if (countJsonString(key, counter) || addBytes(counter, 1)) return true;
        if (countCanonicalJson(item, counter, `${path}.${key}`)) return true;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined);
      if (addBytes(counter, 1)) return true;
      for (let index = 0; index < entries.length; index += 1) {
        const [key, item] = entries[index]!;
        if (index > 0 && addBytes(counter, 1)) return true;
        if (countJsonString(key, counter) || addBytes(counter, 1)) return true;
        if (countCanonicalJson(item, counter, `${path}.${key}`)) return true;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  throw new Error(`worker payload의 ${path} 값은 JSON으로 직렬화할 수 없습니다.`);
}

function shouldOffload(value: unknown, threshold: number): boolean {
  return countCanonicalJson(value, {
    bytes: 0,
    threshold,
    ancestors: new WeakSet(),
  });
}

function encodeCanonicalArtifact(value: unknown): Omit<EncodedArtifact, "offloaded"> {
  const contentJson = canonicalJson(value);
  return {
    contentJson,
    checksum: createHash("sha256").update(contentJson).digest("hex"),
    byteCount: Buffer.byteLength(contentJson),
  };
}

function serializedError(error: unknown): NonNullable<CodecWorkerResponse["error"]> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "artifact codec worker failed",
  };
}

function workerError(error: NonNullable<CodecWorkerResponse["error"]>): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

if (!isMainThread && workerData === ARTIFACT_CODEC_WORKER_MARKER) {
  const port = parentPort;
  if (!port) throw new Error("artifact codec worker parent port is unavailable");
  port.on("message", (request: CodecWorkerRequest) => {
    let response: CodecWorkerResponse;
    try {
      response = {
        id: request.id,
        result: encodeCanonicalArtifact(request.value),
      };
    } catch (error) {
      response = {
        id: request.id,
        error: serializedError(error),
      };
    }
    port.postMessage(response);
  });
}

export class ArtifactCodec {
  private readonly offloadThresholdBytes: number;
  private readonly workerIdleMs: number;
  private readonly pending = new Map<number, PendingEncoding>();
  private worker?: Worker;
  private idleTimer?: NodeJS.Timeout;
  private nextRequestId = 0;
  private closed = false;

  constructor(options: ArtifactCodecOptions = {}) {
    this.offloadThresholdBytes = options.offloadThresholdBytes
      ?? ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES;
    this.workerIdleMs = options.workerIdleMs ?? 1_000;
    if (!Number.isSafeInteger(this.offloadThresholdBytes) || this.offloadThresholdBytes < 1) {
      throw new Error("artifact codec offload threshold must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.workerIdleMs) || this.workerIdleMs < 0) {
      throw new Error("artifact codec worker idle timeout must be a non-negative safe integer");
    }
  }

  async encode(value: unknown): Promise<EncodedArtifact> {
    if (this.closed) throw new Error("artifact codec is closed");
    if (!shouldOffload(value, this.offloadThresholdBytes)) {
      return {
        ...encodeCanonicalArtifact(value),
        offloaded: false,
      };
    }
    return this.encodeInWorker(value);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    const error = new Error("artifact codec closed before encoding completed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker) await worker.terminate();
  }

  private encodeInWorker(value: unknown): Promise<EncodedArtifact> {
    const worker = this.ensureWorker();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    worker.ref();
    const id = ++this.nextRequestId;
    return new Promise<EncodedArtifact>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, value } satisfies CodecWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        this.scheduleWorkerIdle(worker);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const sourceModule = import.meta.url.endsWith(".ts");
    const worker = sourceModule
      ? new Worker(
          `import("tsx/esm/api")`
            + `.then(({ tsImport }) => tsImport(${JSON.stringify(import.meta.url)}, ${JSON.stringify(import.meta.url)}))`
            + `.catch((error) => process.nextTick(() => { throw error; }))`,
          {
            eval: true,
            execArgv: [],
            workerData: ARTIFACT_CODEC_WORKER_MARKER,
          },
        )
      : new Worker(new URL(import.meta.url), {
          execArgv: [],
          workerData: ARTIFACT_CODEC_WORKER_MARKER,
        });
    worker.on("message", (message: CodecWorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(workerError(message.error));
      } else if (message.result) {
        pending.resolve({ ...message.result, offloaded: true });
      } else {
        pending.reject(new Error("artifact codec worker returned an invalid response"));
      }
      this.scheduleWorkerIdle(worker);
    });
    worker.on("error", (error) => this.resetWorker(worker, error));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.resetWorker(
        worker,
        new Error(`artifact codec worker exited before completion (code ${code})`),
      );
    });
    this.worker = worker;
    worker.unref();
    return worker;
  }

  private scheduleWorkerIdle(worker: Worker): void {
    if (this.worker !== worker || this.pending.size > 0) return;
    worker.unref();
    if (this.workerIdleMs === 0) {
      this.worker = undefined;
      void worker.terminate();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker !== worker || this.pending.size > 0) return;
      this.worker = undefined;
      void worker.terminate();
    }, this.workerIdleMs);
    this.idleTimer.unref();
  }

  private resetWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
