import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES,
  ArtifactCodec,
} from "./artifact-codec.js";
import { canonicalJsonExceedsByteLimit } from "../json-byte-limit.js";
import { canonicalJson } from "../worker/canonical-json.js";

describe("ArtifactCodec", () => {
  it("counts canonical JSON bytes without allocating the full serialized payload", () => {
    const value = {
      ascii: "plain",
      escaped: "line\nbreak",
      unicode: "포트폴리오 📈",
      omitted: undefined,
    };
    const byteCount = Buffer.byteLength(canonicalJson(value));

    expect(canonicalJsonExceedsByteLimit(value, byteCount)).toBe(false);
    expect(canonicalJsonExceedsByteLimit(value, byteCount - 1)).toBe(true);
    expect(() => canonicalJsonExceedsByteLimit(value, -1)).toThrow(/byte limit/u);
  });

  it("matches canonical JSON for sparse arrays and preserves nested error paths", () => {
    const sparse = new Array(3) as unknown[];
    sparse[1] = "한";
    const byteCount = Buffer.byteLength(canonicalJson(sparse));

    expect(canonicalJson(sparse)).toBe('[null,"한",null]');
    expect(canonicalJsonExceedsByteLimit(sparse, byteCount)).toBe(false);
    expect(canonicalJsonExceedsByteLimit(sparse, byteCount - 1)).toBe(true);
    expect(() => canonicalJsonExceedsByteLimit({ rows: [{ value: Number.NaN }] }, 1_000))
      .toThrow("worker payload의 $.rows[0].value 값은 유한한 숫자여야 합니다.");
  });

  it("작은 payload는 현재 thread에서 canonicalize하고 기존 checksum 규칙을 유지한다", async () => {
    const codec = new ArtifactCodec();
    try {
      const value = {
        z: 2,
        nested: new Map<string, unknown>([
          ["z", -0],
          ["a", { omitted: undefined, value: "한글" }],
        ]),
        a: 1,
      };
      const expected = canonicalJson(value);

      await expect(codec.encode(value)).resolves.toEqual({
        contentJson: expected,
        checksum: createHash("sha256").update(expected).digest("hex"),
        byteCount: Buffer.byteLength(expected),
        offloaded: false,
      });
    } finally {
      await codec.close();
    }
  });

  it("canonical JSON이 1MiB 이상이면 worker thread에서 동일한 bytes를 생성한다", async () => {
    const codec = new ArtifactCodec({ workerIdleMs: 0 });
    try {
      const value = {
        z: "tail",
        payload: "x".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES),
        a: [{ second: 2, first: 1 }],
      };
      const expected = canonicalJson(value);
      const encoded = await codec.encode(value);

      expect(encoded.offloaded).toBe(true);
      expect(encoded.contentJson).toBe(expected);
      expect(encoded.byteCount).toBe(Buffer.byteLength(expected));
      expect(encoded.checksum).toBe(createHash("sha256").update(expected).digest("hex"));
    } finally {
      await codec.close();
    }
  });

  it("worker mailbox에는 한 요청만 clone하고 나머지는 bounded queue에서 대기시킨다", async () => {
    const codec = new ArtifactCodec({
      maximumPendingEncodings: 2,
      workerIdleMs: 0,
    });
    let queuedCloneReads = 0;
    const queuedValue = {
      payload: "q".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES),
      get clonedAfterAdmission() {
        queuedCloneReads += 1;
        return true;
      },
    };
    try {
      const first = codec.encode({
        payload: "f".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES * 4),
      });
      const second = codec.encode(queuedValue);
      const rejected = codec.encode({
        payload: "r".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES),
      });

      // The size preflight stops inside payload, so this getter is only read by
      // structured clone. The second request must not enter the worker mailbox
      // while the first synchronous worker handler is still running.
      expect(queuedCloneReads).toBe(0);
      await expect(rejected).rejects.toThrow("pending encoding limit (2) exceeded");
      await expect(first).resolves.toMatchObject({ offloaded: true });
      await expect(second).resolves.toMatchObject({ offloaded: true });
      expect(queuedCloneReads).toBe(1);
    } finally {
      await codec.close();
    }
  });

  it("validates the pending admission limit", () => {
    expect(() => new ArtifactCodec({ maximumPendingEncodings: 0 }))
      .toThrow("pending encoding limit must be a positive safe integer");
  });

  it("close rejects both the active worker request and queued requests", async () => {
    const codec = new ArtifactCodec({ maximumPendingEncodings: 2 });
    const active = codec.encode({
      payload: "a".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES * 4),
    });
    const queued = codec.encode({
      payload: "q".repeat(ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES),
    });

    const closing = codec.close();
    await expect(active).rejects.toThrow("closed before encoding completed");
    await expect(queued).rejects.toThrow("closed before encoding completed");
    await closing;
  });
});
