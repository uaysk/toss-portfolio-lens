import { createHash } from "node:crypto";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { canonicalJsonExceedsByteLimit } from "../json-byte-limit.js";
import { canonicalJson } from "../worker/canonical-json.js";

export const ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES = 1024 * 1024;
export const ARTIFACT_CODEC_MAX_PENDING_ENCODINGS = 256;

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
  maximumPendingEncodings?: number;
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

type QueuedEncoding = PendingEncoding & {
  value: unknown;
};

function shouldOffload(value: unknown, threshold: number): boolean {
  return canonicalJsonExceedsByteLimit(value, threshold - 1);
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
  private readonly maximumPendingEncodings: number;
  private readonly pending = new Map<number, PendingEncoding>();
  private readonly queue: QueuedEncoding[] = [];
  private worker?: Worker;
  private idleTimer?: NodeJS.Timeout;
  private nextRequestId = 0;
  private closed = false;

  constructor(options: ArtifactCodecOptions = {}) {
    this.offloadThresholdBytes = options.offloadThresholdBytes
      ?? ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES;
    this.workerIdleMs = options.workerIdleMs ?? 1_000;
    this.maximumPendingEncodings = options.maximumPendingEncodings
      ?? ARTIFACT_CODEC_MAX_PENDING_ENCODINGS;
    if (!Number.isSafeInteger(this.offloadThresholdBytes) || this.offloadThresholdBytes < 1) {
      throw new Error("artifact codec offload threshold must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.workerIdleMs) || this.workerIdleMs < 0) {
      throw new Error("artifact codec worker idle timeout must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.maximumPendingEncodings)
      || this.maximumPendingEncodings < 1) {
      throw new Error("artifact codec pending encoding limit must be a positive safe integer");
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
    for (const queued of this.queue) queued.reject(error);
    this.queue.length = 0;
    if (worker) await worker.terminate();
  }

  private encodeInWorker(value: unknown): Promise<EncodedArtifact> {
    if (this.pending.size + this.queue.length >= this.maximumPendingEncodings) {
      return Promise.reject(new Error(
        `artifact codec pending encoding limit (${this.maximumPendingEncodings}) exceeded`,
      ));
    }
    return new Promise<EncodedArtifact>((resolve, reject) => {
      this.queue.push({ value, resolve, reject });
      this.pumpWorker();
    });
  }

  private pumpWorker(): void {
    // A single worker executes this CPU-bound handler synchronously. Posting
    // more than one request only fills the MessagePort with structured-cloned
    // copies; it does not add throughput. Keep exactly one cloned request in
    // flight and retain the remaining caller-owned values in the bounded queue.
    if (this.closed || this.pending.size > 0 || this.queue.length === 0) return;
    const queued = this.queue.shift()!;
    const { value, resolve, reject } = queued;
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      reject(error);
      for (const remaining of this.queue) remaining.reject(error);
      this.queue.length = 0;
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    worker.ref();
    const id = ++this.nextRequestId;
    this.pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, value } satisfies CodecWorkerRequest);
    } catch (error) {
      this.pending.delete(id);
      reject(error);
      this.pumpWorker();
      if (this.pending.size === 0 && this.queue.length === 0) {
        this.scheduleWorkerIdle(worker);
      }
    }
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
      this.pumpWorker();
      if (this.pending.size === 0 && this.queue.length === 0) {
        this.scheduleWorkerIdle(worker);
      }
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
    if (this.worker !== worker
      || this.pending.size > 0
      || this.queue.length > 0
      || this.idleTimer) return;
    worker.unref();
    if (this.workerIdleMs === 0) {
      this.worker = undefined;
      void worker.terminate();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker !== worker || this.pending.size > 0 || this.queue.length > 0) return;
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
    for (const queued of this.queue) queued.reject(error);
    this.queue.length = 0;
  }
}
