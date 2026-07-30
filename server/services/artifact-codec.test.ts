import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CODEC_OFFLOAD_THRESHOLD_BYTES,
  ArtifactCodec,
} from "./artifact-codec.js";
import { canonicalJson } from "../worker/canonical-json.js";

describe("ArtifactCodec", () => {
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
});
