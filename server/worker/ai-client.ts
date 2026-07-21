import net from "node:net";
import { AiRequestSchema, AiResponseSchema, type AiRequest, type AiResponse } from "./ai-contract.js";

export type AiComputeClientConfig = {
  socketPath: string;
  timeoutMs: number;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
};

export type AiComputeClientOptions = {
  createConnection?: (socketPath: string) => net.Socket;
};

const MINIMUM_FRAME_BYTES = 1_024;
const MAXIMUM_FRAME_BYTES = 512 * 1024 * 1024;

function frameLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < MINIMUM_FRAME_BYTES || resolved > MAXIMUM_FRAME_BYTES) {
    throw new Error(`${name}는 ${MINIMUM_FRAME_BYTES}~${MAXIMUM_FRAME_BYTES} 바이트 범위여야 합니다.`);
  }
  return resolved;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("AI compute 요청이 취소되었습니다.");
}

export class AiComputeClient {
  private readonly maximumRequestBytes: number;
  private readonly maximumResponseBytes: number;

  private readonly createConnection: (socketPath: string) => net.Socket;

  constructor(private readonly config: AiComputeClientConfig, options: AiComputeClientOptions = {}) {
    if (!config.socketPath.trim()) throw new Error("AI compute socket 경로가 필요합니다.");
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1) throw new Error("AI compute timeout이 올바르지 않습니다.");
    this.maximumRequestBytes = frameLimit(config.maximumRequestBytes, 64 * 1024 * 1024, "AI compute 요청 상한");
    this.maximumResponseBytes = frameLimit(config.maximumResponseBytes, 128 * 1024 * 1024, "AI compute 응답 상한");
    this.createConnection = options.createConnection ?? ((socketPath) => net.createConnection({ path: socketPath }));
  }

  request(input: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const request = AiRequestSchema.parse(input);
    const source = Buffer.from(JSON.stringify(request), "utf8");
    if (source.byteLength === 0 || source.byteLength > this.maximumRequestBytes || source.byteLength > 0xffff_ffff) {
      throw new Error("AI compute 요청이 크기 상한을 초과했습니다.");
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const frame = Buffer.allocUnsafe(source.byteLength + 4);
    frame.writeUInt32BE(source.byteLength, 0);
    source.copy(frame, 4);

    return new Promise<AiResponse>((resolve, reject) => {
      const socket = this.createConnection(this.config.socketPath);
      const chunks: Buffer[] = [];
      let buffered = 0;
      let expected: number | undefined;
      let settled = false;
      const finish = (error?: Error, response?: AiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const onAbort = () => finish(abortError(signal!));
      const timer = setTimeout(() => {
        finish(new Error(`AI compute 응답 제한 시간 ${this.config.timeoutMs}ms를 초과했습니다.`));
      }, this.config.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => socket.write(frame));
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        buffered += chunk.byteLength;
        if (buffered > this.maximumResponseBytes + 4) {
          finish(new Error("AI compute 응답이 크기 상한을 초과했습니다."));
          return;
        }
        const combined = Buffer.concat(chunks, buffered);
        if (expected === undefined && combined.byteLength >= 4) {
          expected = combined.readUInt32BE(0);
          if (expected === 0 || expected > this.maximumResponseBytes) {
            finish(new Error("AI compute 응답 프레임 크기가 유효하지 않습니다."));
            return;
          }
        }
        if (expected === undefined || combined.byteLength < expected + 4) return;
        if (combined.byteLength !== expected + 4) {
          finish(new Error("AI compute 응답에 예기치 않은 후속 바이트가 있습니다."));
          return;
        }
        try {
          const parsed = AiResponseSchema.parse(JSON.parse(combined.subarray(4).toString("utf8")) as unknown);
          if (parsed.request_id !== request.request_id || parsed.mode !== request.mode) {
            throw new Error("AI compute 응답 identity가 요청과 일치하지 않습니다.");
          }
          finish(undefined, parsed);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("AI compute 응답을 해석할 수 없습니다."));
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new Error("AI compute socket이 응답 전에 종료되었습니다."));
      });
      if (signal?.aborted) onAbort();
    });
  }
}
