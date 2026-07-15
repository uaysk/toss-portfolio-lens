import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportStorageConfig, S3ReportStorageConfig } from "./env.js";

const MAX_REPORT_BYTES = 12 * 1024 * 1024;

export interface ReportStorage {
  readonly backend: "local" | "s3";
  put(id: string, document: unknown): Promise<void>;
  get(id: string): Promise<unknown | undefined>;
}

function serialized(document: unknown): string {
  const value = JSON.stringify(document);
  if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("보고서 데이터가 저장 가능한 크기를 초과했습니다.");
  }
  return value;
}

export class LocalReportStorage implements ReportStorage {
  readonly backend = "local" as const;

  constructor(private readonly directory: string) {}

  private filename(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  async put(id: string, document: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filename = this.filename(id);
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, serialized(document), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  }

  async get(id: string): Promise<unknown | undefined> {
    try {
      const value = await readFile(this.filename(id), "utf8");
      if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
        throw new Error("저장된 보고서가 허용된 크기를 초과했습니다.");
      }
      return JSON.parse(value) as unknown;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

type S3Sender = {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
};

export class S3ReportStorage implements ReportStorage {
  readonly backend = "s3" as const;
  private readonly client: S3Sender;

  constructor(
    private readonly config: S3ReportStorageConfig,
    client?: S3Sender,
  ) {
    this.client = client ?? new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
  }

  private key(id: string): string {
    return `${this.config.prefix}/${id}.json`;
  }

  async put(id: string, document: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: this.key(id),
      Body: serialized(document),
      ContentType: "application/json; charset=utf-8",
      CacheControl: "private, no-store",
      ServerSideEncryption: "AES256",
    }));
  }

  async get(id: string): Promise<unknown | undefined> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(id),
      })) as { Body?: { transformToString(encoding?: string): Promise<string> }; ContentLength?: number };
      if (output.ContentLength && output.ContentLength > MAX_REPORT_BYTES) {
        throw new Error("저장된 보고서가 허용된 크기를 초과했습니다.");
      }
      if (!output.Body) throw new Error("S3 보고서 본문이 비어 있습니다.");
      const value = await output.Body.transformToString("utf-8");
      if (Buffer.byteLength(value, "utf8") > MAX_REPORT_BYTES) {
        throw new Error("저장된 보고서가 허용된 크기를 초과했습니다.");
      }
      return JSON.parse(value) as unknown;
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      const status = error && typeof error === "object" && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) return undefined;
      throw error;
    }
  }
}

export function createReportStorage(config: ReportStorageConfig): ReportStorage {
  return config.kind === "s3"
    ? new S3ReportStorage(config)
    : new LocalReportStorage(path.resolve(config.directory));
}
