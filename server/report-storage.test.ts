import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalReportStorage, S3ReportStorage } from "./report-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("report storage", () => {
  it("로컬 보고서를 원자적으로 저장하고 읽는다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-reports-"));
    temporaryDirectories.push(directory);
    const storage = new LocalReportStorage(directory);
    await storage.put("report-id", { value: 42 });
    await expect(storage.get("report-id")).resolves.toEqual({ value: 42 });
    await storage.delete("report-id");
    await expect(storage.get("report-id")).resolves.toBeUndefined();
    await expect(storage.delete("report-id")).resolves.toBeUndefined();
    await expect(storage.get("missing")).resolves.toBeUndefined();
  });

  it("로컬 보고서가 상한보다 크면 본문을 읽기 전에 거부한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-reports-"));
    temporaryDirectories.push(directory);
    const storage = new LocalReportStorage(directory);
    const filename = path.join(directory, "oversized-report.json");
    await writeFile(filename, "{}");
    await truncate(filename, 12 * 1024 * 1024 + 1);

    await expect(storage.get("oversized-report")).rejects.toThrow("허용된 크기를 초과했습니다");
  });

  it("로컬 rename이 실패하면 작성한 임시파일을 정리한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-reports-"));
    temporaryDirectories.push(directory);
    const storage = new LocalReportStorage(directory);
    await mkdir(path.join(directory, "blocked.json"));

    await expect(storage.put("blocked", { value: 42 })).rejects.toBeDefined();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("로컬 저장소 경계를 벗어나는 ID를 I/O 전에 거부한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "portfolio-reports-boundary-"));
    temporaryDirectories.push(root);
    const storage = new LocalReportStorage(path.join(root, "reports"));

    await expect(storage.put("../outside", { value: 42 })).rejects.toThrow("ID가 올바르지 않습니다");
    await expect(storage.get("../outside")).rejects.toThrow("ID가 올바르지 않습니다");
    await expect(storage.delete("../outside")).rejects.toThrow("ID가 올바르지 않습니다");
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("S3 키에 JSON을 저장하고 같은 키에서 읽는다", async () => {
    let stored = "";
    const send = vi.fn(async (
      command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => {
      if (command instanceof PutObjectCommand) {
        stored = String(command.input.Body);
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        stored = "";
        return {};
      }
      return {
        ContentLength: Buffer.byteLength(stored),
        Body: { transformToString: async () => stored },
      };
    });
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });
    await storage.put("report-id", { value: 7 });
    await expect(storage.get("report-id")).resolves.toEqual({ value: 7 });
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.Key).toBe("lens/report-id.json");
    expect(send.mock.calls[0][1]?.abortSignal).toBeInstanceOf(AbortSignal);
    await storage.delete("report-id");
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[2][0] as DeleteObjectCommand).input.Key).toBe("lens/report-id.json");
    expect(send.mock.calls[2][1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("S3 응답 본문이 timeout을 넘기면 스트림을 파기하고 timer를 정리한다", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const send = vi.fn(async (
      _command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => ({
      Body: {
        transformToString: vi.fn(async () => "{}"),
        destroy,
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        }),
      },
    }));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    const pending = expect(storage.get("report-id")).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5_000);

    await pending;
    expect(destroy).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]?.abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ContentLength가 상한을 넘으면 본문을 읽지 않고 스트림을 파기한다", async () => {
    const transformToString = vi.fn(async () => "{}");
    const destroy = vi.fn();
    const send = vi.fn(async (
      _command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => ({
      ContentLength: 12 * 1024 * 1024 + 1,
      Body: { transformToString, destroy },
    }));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    await expect(storage.get("oversized-report")).rejects.toThrow("허용된 크기를 초과했습니다");
    expect(destroy).toHaveBeenCalledOnce();
    expect(transformToString).not.toHaveBeenCalled();
  });

  it("ContentLength가 없어도 스트림을 상한까지만 읽고 초과 시 파기한다", async () => {
    const transformToString = vi.fn(async () => "{}");
    const destroy = vi.fn();
    const chunk = Buffer.alloc(7 * 1024 * 1024, 0x20);
    const send = vi.fn(async (
      _command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => ({
      Body: {
        transformToString,
        destroy,
        async *[Symbol.asyncIterator]() {
          yield chunk;
          yield chunk;
        },
      },
    }));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    await expect(storage.get("oversized-report")).rejects.toThrow("허용된 크기를 초과했습니다");
    expect(destroy).toHaveBeenCalledOnce();
    expect(transformToString).not.toHaveBeenCalled();
  });

  it("ContentLength가 없는 정상 스트림을 제한 안에서 읽는다", async () => {
    const send = vi.fn(async (
      _command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => ({
      Body: {
        transformToString: vi.fn(async () => "사용되지 않음"),
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{"value":"안');
          yield Buffer.from('전"}');
        },
      },
    }));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    await expect(storage.get("streamed-report")).resolves.toEqual({ value: "안전" });
  });

  it("ContentLength와 스트림이 모두 없으면 무제한 변환 대신 거부한다", async () => {
    const transformToString = vi.fn(async () => "{}");
    const destroy = vi.fn();
    const send = vi.fn(async (
      _command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand,
      _options?: { abortSignal?: AbortSignal },
    ) => ({ Body: { transformToString, destroy } }));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    await expect(storage.get("unknown-length-report")).rejects.toThrow("안전하게 읽을 수 없습니다");
    expect(destroy).toHaveBeenCalledOnce();
    expect(transformToString).not.toHaveBeenCalled();
  });

  it("S3 저장소 경계를 벗어나는 ID를 요청 전에 거부한다", async () => {
    const send = vi.fn(async () => ({}));
    const storage = new S3ReportStorage({
      kind: "s3",
      bucket: "reports",
      region: "ap-northeast-2",
      prefix: "lens",
      timeoutMs: 5_000,
      forcePathStyle: false,
    }, { send });

    await expect(storage.get("../outside")).rejects.toThrow("ID가 올바르지 않습니다");
    await expect(storage.delete("../outside")).rejects.toThrow("ID가 올바르지 않습니다");
    expect(send).not.toHaveBeenCalled();
  });
});
