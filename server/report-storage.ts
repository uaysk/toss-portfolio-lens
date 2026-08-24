import type { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportStorageConfig, S3ReportStorageConfig } from "./env.js";

const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ReportStorage {
  readonly backend: "local" | "s3";
  put(id: string, document: unknown): Promise<void>;
  get(id: string): Promise<unknown | undefined>;
  delete(id: string): Promise<void>;
}

function serialized(document: unknown): string {
  const value = JSON.stringify(document);
  if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("보고서 데이터가 저장 가능한 크기를 초과했습니다.");
  }
  return value;
}

function assertReportId(id: string): void {
  if (!REPORT_ID_PATTERN.test(id)) {
    throw new Error("보고서 ID가 올바르지 않습니다.");
  }
}

function oversizedStoredReportError(): Error {
  return new Error("저장된 보고서가 허용된 크기를 초과했습니다.");
}

export class LocalReportStorage implements ReportStorage {
  readonly backend = "local" as const;

  constructor(private readonly directory: string) {}

  private filename(id: string): string {
    assertReportId(id);
    return path.join(this.directory, `${id}.json`);
  }

  async put(id: string, document: unknown): Promise<void> {
    const filename = this.filename(id);
    const value = serialized(document);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filename);
      committed = true;
    } finally {
      if (!committed) {
        try {
          await unlink(temporary);
        } catch {
          // Preserve the write/rename error when best-effort temporary cleanup fails.
        }
      }
    }
  }

  async get(id: string): Promise<unknown | undefined> {
    const filename = this.filename(id);
    try {
      const handle = await open(filename, "r");
      try {
        const metadata = await handle.stat();
        if (metadata.size > MAX_REPORT_BYTES) {
          throw oversizedStoredReportError();
        }
        const value = await handle.readFile("utf8");
        if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
          throw oversizedStoredReportError();
        }
        return JSON.parse(value) as unknown;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.filename(id));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

type S3Sender = {
  send(
    command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
};

type S3Body = {
  transformToString(encoding?: string): Promise<string>;
  destroy?(error?: Error): void;
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array | string>;
};

type S3Module = typeof import("@aws-sdk/client-s3");

let s3ModulePromise: Promise<S3Module> | undefined;

function loadS3Module(): Promise<S3Module> {
  s3ModulePromise ??= import("@aws-sdk/client-s3");
  return s3ModulePromise;
}

function timeoutError(): Error {
  return Object.assign(new Error("S3 보고서 저장소 요청 시간이 초과되었습니다."), {
    name: "TimeoutError",
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("S3 보고서 저장소 요청이 중단되었습니다."), { name: "AbortError" });
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: (error: Error) => void,
): Promise<T> {
  if (signal.aborted) {
    const error = abortReason(signal);
    try {
      onAbort?.(error);
    } catch {
      // The timeout remains authoritative even if best-effort stream teardown fails.
    }
    throw error;
  }
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => {
    const error = abortReason(signal);
    try {
      onAbort?.(error);
    } catch {
      // The timeout remains authoritative even if best-effort stream teardown fails.
    }
    rejectAbort(error);
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
}

function destroyBody(body: S3Body, error?: Error): void {
  try {
    body.destroy?.(error);
  } catch {
    // Preserve the authoritative storage error when best-effort stream teardown fails.
  }
}

async function readBoundedBody(
  body: S3Body,
  contentLength: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  const iteratorFactory = body[Symbol.asyncIterator];
  if (typeof iteratorFactory === "function") {
    const iterator = iteratorFactory.call(body);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const step = await abortable(
        Promise.resolve(iterator.next()),
        signal,
        (error) => destroyBody(body, error),
      );
      if (step.done) break;
      const chunk = typeof step.value === "string"
        ? Buffer.from(step.value, "utf8")
        : Buffer.isBuffer(step.value)
          ? step.value
          : Buffer.from(step.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_REPORT_BYTES) {
        const error = oversizedStoredReportError();
        destroyBody(body, error);
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  }

  if (contentLength === undefined) {
    const error = new Error("S3 보고서 크기를 확인할 수 없어 안전하게 읽을 수 없습니다.");
    destroyBody(body, error);
    throw error;
  }

  const value = await abortable(
    body.transformToString("utf-8"),
    signal,
    (error) => destroyBody(body, error),
  );
  if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
    const error = oversizedStoredReportError();
    destroyBody(body, error);
    throw error;
  }
  return value;
}

export class S3ReportStorage implements ReportStorage {
  readonly backend = "s3" as const;
  private clientPromise?: Promise<S3Sender>;

  constructor(
    private readonly config: S3ReportStorageConfig,
    client?: S3Sender,
  ) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 5_000 || config.timeoutMs > 180_000) {
      throw new Error("S3 timeout은 5000~180000ms 범위여야 합니다.");
    }
    if (client) this.clientPromise = Promise.resolve(client);
  }

  private key(id: string): string {
    assertReportId(id);
    return `${this.config.prefix}/${id}.json`;
  }

  private getClient(): Promise<S3Sender> {
    this.clientPromise ??= loadS3Module().then(({ S3Client }) => new S3Client({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      forcePathStyle: this.config.forcePathStyle,
      ...(this.config.credentials ? { credentials: this.config.credentials } : {}),
    }));
    return this.clientPromise;
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), this.config.timeoutMs);
    try {
      return await abortable(operation(controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async put(id: string, document: unknown): Promise<void> {
    const key = this.key(id);
    const body = serialized(document);
    await this.withTimeout(async (signal) => {
      const [{ PutObjectCommand }, client] = await Promise.all([loadS3Module(), this.getClient()]);
      await client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "private, no-store",
        ServerSideEncryption: "AES256",
      }), { abortSignal: signal });
    });
  }

  async get(id: string): Promise<unknown | undefined> {
    const key = this.key(id);
    try {
      return await this.withTimeout(async (signal) => {
        const [{ GetObjectCommand }, client] = await Promise.all([loadS3Module(), this.getClient()]);
        const output = await client.send(new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }), { abortSignal: signal }) as { Body?: S3Body; ContentLength?: number };
        if (typeof output.ContentLength === "number" && output.ContentLength > MAX_REPORT_BYTES) {
          if (output.Body) destroyBody(output.Body);
          throw oversizedStoredReportError();
        }
        if (!output.Body) throw new Error("S3 보고서 본문이 비어 있습니다.");
        const contentLength = typeof output.ContentLength === "number"
          && Number.isSafeInteger(output.ContentLength)
          && output.ContentLength >= 0
          ? output.ContentLength
          : undefined;
        const value = await readBoundedBody(output.Body, contentLength, signal);
        return JSON.parse(value) as unknown;
      });
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      const status = error && typeof error === "object" && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) return undefined;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const key = this.key(id);
    await this.withTimeout(async (signal) => {
      const [{ DeleteObjectCommand }, client] = await Promise.all([loadS3Module(), this.getClient()]);
      await client.send(new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }), { abortSignal: signal });
    });
  }
}

export function createReportStorage(config: ReportStorageConfig): ReportStorage {
  return config.kind === "s3"
    ? new S3ReportStorage(config)
    : new LocalReportStorage(path.resolve(config.directory));
}
