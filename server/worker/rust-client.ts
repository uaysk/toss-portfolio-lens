import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { WorkerOutputSchema, WORKER_PAYLOAD_SCHEMA_VERSION, type WorkerOutput } from "./contracts.js";
import type { PortfolioRunKind } from "../repositories/run-repository.js";
import { PORTFOLIO_ENGINE_VERSION } from "../services/service-envelope.js";

type Pending = {
  resolve: (value: WorkerOutput) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  runId: string;
  kind: PortfolioRunKind;
  dataRevision: string;
  requestHash: string;
  cleanupAbort?: () => void;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Rust compute 요청이 취소되었습니다.");
}

class RustSocketChannel {
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private chunks: Buffer[] = [];
  private headOffset = 0;
  private bufferedBytes = 0;
  private expectedFrameBytes?: number;
  private readonly pending: Pending[] = [];

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes = 128 * 1024 * 1024,
  ) {}

  async request(
    kind: PortfolioRunKind,
    payload: Record<string, unknown>,
    includeArtifacts: boolean,
    signal?: AbortSignal,
  ): Promise<WorkerOutput> {
    if (signal?.aborted) throw abortReason(signal);
    await this.connect(signal);
    if (signal?.aborted) {
      const error = abortReason(signal);
      this.reset(error);
      throw error;
    }
    const safePayload = jsonSafe(payload) as Record<string, unknown>;
    const runId = randomUUID();
    const dataRevision = "ipc";
    const payloadJson = JSON.stringify(safePayload);
    const requestHash = createHash("sha256")
      .update(runId)
      .update("\0")
      .update(kind)
      .update("\0")
      .update(payloadJson)
      .digest("hex");
    const metadataJson = JSON.stringify({
      schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
      engine_version: PORTFOLIO_ENGINE_VERSION,
      run_id: runId,
      job_kind: kind,
      data_revision: dataRevision,
      request_hash: requestHash,
    });
    const source = Buffer.from(
      `${metadataJson.slice(0, -1)},"payload":${payloadJson},"include_artifacts":${includeArtifacts}}`,
      "utf8",
    );
    if (source.byteLength > this.maxResponseBytes) throw new Error("Rust compute 요청이 128MiB 상한을 초과했습니다.");
    if (source.byteLength > 0xffff_ffff) {
      throw new Error("Rust compute 요청이 프레임 길이 필드를 초과했습니다.");
    }
    const frame = Buffer.allocUnsafe(4 + source.byteLength);
    frame.writeUInt32BE(source.byteLength, 0);
    source.copy(frame, 4);
    return new Promise<WorkerOutput>((resolve, reject) => {
      let pending!: Pending;
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        pending.cleanupAbort?.();
        reject(new Error(`Rust compute 응답 제한 시간 ${this.timeoutMs}ms를 초과했습니다.`));
        this.reset(new Error("Rust compute socket timeout"));
      }, this.timeoutMs);
      timer.unref();
      pending = {
        resolve,
        reject,
        timer,
        runId,
        kind,
        dataRevision,
        requestHash,
      };
      if (signal) {
        const onAbort = () => this.reset(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.push(pending);
      if (signal?.aborted) {
        this.reset(abortReason(signal));
        return;
      }
      this.socket!.write(frame, (error) => {
        if (error) this.reset(error);
      });
    });
  }

  close(): void {
    this.reset(new Error("Rust compute client closed"));
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onAbort = () => fail(abortReason(signal!));
      const timer = setTimeout(() => {
        fail(new Error(`Rust compute socket 연결 제한 시간 ${this.timeoutMs}ms를 초과했습니다.`));
      }, this.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.reset(error));
        socket.on("close", () => this.reset(new Error("Rust compute socket closed"), socket));
        resolve();
      });
      socket.once("error", (error) => {
        fail(error);
      });
      if (signal?.aborted) onAbort();
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    if (this.bufferedBytes > this.maxResponseBytes) {
      this.reset(new Error("Rust compute 응답이 128MiB 상한을 초과했습니다."));
      return;
    }
    while (true) {
      if (this.expectedFrameBytes === undefined) {
        if (this.bufferedBytes < 4) return;
        this.expectedFrameBytes = this.take(4).readUInt32BE(0);
        if (this.expectedFrameBytes === 0 || this.expectedFrameBytes > this.maxResponseBytes) {
          this.reset(new Error("Rust compute 응답 프레임 크기가 유효하지 않습니다."));
          return;
        }
      }
      if (this.bufferedBytes < this.expectedFrameBytes) return;
      const frame = this.take(this.expectedFrameBytes);
      this.expectedFrameBytes = undefined;
      const pending = this.pending.shift();
      if (!pending) {
        this.reset(new Error("Rust compute 응답 순서가 요청과 일치하지 않습니다."));
        return;
      }
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      try {
        const raw = JSON.parse(frame.toString("utf8")) as unknown;
        if (typeof raw === "object" && raw && "status" in raw && (raw as { status?: string }).status === "failed"
          && !("schema_version" in raw)) {
          const detail = (raw as { error?: { message?: string } }).error;
          throw new Error(detail?.message || "Rust compute 실행에 실패했습니다.");
        }
        const output = WorkerOutputSchema.parse(raw);
        if (output.status !== "completed") throw new Error("Rust compute가 완료 상태를 반환하지 않았습니다.");
        if (output.engine_version !== PORTFOLIO_ENGINE_VERSION
          || output.run_id !== pending.runId
          || output.job_kind !== pending.kind
          || output.data_revision !== pending.dataRevision
          || output.request_hash !== pending.requestHash
          || output.payload_hash === undefined) {
          throw new Error("Rust compute 응답 identity가 요청과 일치하지 않습니다.");
        }
        pending.resolve(output);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("Rust compute 응답을 해석할 수 없습니다."));
      }
    }
  }

  private take(length: number): Buffer {
    if (length > this.bufferedBytes) throw new Error("Rust compute 내부 프레임 버퍼가 부족합니다.");
    const first = this.chunks[0];
    const firstAvailable = first.byteLength - this.headOffset;
    if (firstAvailable >= length) {
      const result = first.subarray(this.headOffset, this.headOffset + length);
      this.headOffset += length;
      this.bufferedBytes -= length;
      if (this.headOffset === first.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return result;
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const current = this.chunks[0];
      const available = current.byteLength - this.headOffset;
      const copied = Math.min(available, length - written);
      current.copy(result, written, this.headOffset, this.headOffset + copied);
      written += copied;
      this.headOffset += copied;
      if (this.headOffset === current.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    this.bufferedBytes -= length;
    return result;
  }

  private reset(error: Error, expectedSocket?: net.Socket): void {
    if (expectedSocket && this.socket !== expectedSocket) return;
    const socket = this.socket;
    this.socket = undefined;
    this.chunks = [];
    this.headOffset = 0;
    this.bufferedBytes = 0;
    this.expectedFrameBytes = undefined;
    socket?.removeAllListeners();
    socket?.destroy();
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
  }
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), jsonSafe(item)]));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

export class RustComputeClient {
  private readonly channels: RustSocketChannel[];
  private readonly transientChannels = new Set<RustSocketChannel>();
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private next = 0;

  constructor(input: { socketPath: string; poolSize?: number; timeoutMs?: number }) {
    const poolSize = Math.max(1, Math.min(32, Math.trunc(input.poolSize ?? 2)));
    const timeoutMs = Math.max(1_000, Math.min(3_600_000, Math.trunc(input.timeoutMs ?? 300_000)));
    this.socketPath = input.socketPath;
    this.timeoutMs = timeoutMs;
    this.channels = Array.from({ length: poolSize }, () => new RustSocketChannel(input.socketPath, timeoutMs));
  }

  async compute<T>(kind: PortfolioRunKind, payload: Record<string, unknown>, options: {
    includeArtifacts?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<{
    result: T;
    summary: unknown;
    warnings: string[];
    artifacts: NonNullable<WorkerOutput["artifacts"]>;
  }> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    // A cancellable request owns its connection. Closing a shared FIFO channel would
    // otherwise abort unrelated requests that happen to be queued on the same pool slot.
    const channel = options.signal
      ? new RustSocketChannel(this.socketPath, this.timeoutMs)
      : this.channels[this.next++ % this.channels.length];
    if (options.signal) this.transientChannels.add(channel);
    try {
      const output = await channel.request(kind, payload, options.includeArtifacts ?? true, options.signal);
      if (output.result === undefined) throw new Error("Rust compute 결과가 비어 있습니다.");
      return {
        result: output.result as T,
        summary: output.summary,
        warnings: output.warnings,
        artifacts: output.artifacts ?? [],
      };
    } finally {
      if (options.signal) {
        this.transientChannels.delete(channel);
        channel.close();
      }
    }
  }

  close(): void {
    for (const channel of this.channels) channel.close();
    for (const channel of this.transientChannels) channel.close();
    this.transientChannels.clear();
  }
}
