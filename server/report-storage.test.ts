import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalReportStorage, S3ReportStorage } from "./report-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("report storage", () => {
  it("로컬 보고서를 원자적으로 저장하고 읽는다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-reports-"));
    temporaryDirectories.push(directory);
    const storage = new LocalReportStorage(directory);
    await storage.put("report-id", { value: 42 });
    await expect(storage.get("report-id")).resolves.toEqual({ value: 42 });
    await expect(storage.get("missing")).resolves.toBeUndefined();
  });

  it("S3 키에 JSON을 저장하고 같은 키에서 읽는다", async () => {
    let stored = "";
    const send = vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
      if (command instanceof PutObjectCommand) {
        stored = String(command.input.Body);
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
      forcePathStyle: false,
    }, { send });
    await storage.put("report-id", { value: 7 });
    await expect(storage.get("report-id")).resolves.toEqual({ value: 7 });
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.Key).toBe("lens/report-id.json");
  });
});
