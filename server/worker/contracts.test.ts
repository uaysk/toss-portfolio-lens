import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decodeWorkerArtifact,
  encodeWorkerArtifact,
  WorkerInputSchema,
  WorkerJobKindSchema,
} from "./contracts.js";

const input = {
  schema_version: "1.0" as const,
  engine_version: "portfolio-lens-test",
  run_id: "run-1",
  job_kind: "backtest" as const,
  data_revision: "revision-1",
  request_hash: "a".repeat(64),
  payload: { z: 2, a: { y: 1, x: [3, 2, 1] } },
};

describe("worker contract", () => {
  it("key 순서와 무관하게 canonical JSON과 checksum을 고정한다", () => {
    const unicodeKeys = { "é": 1, "é": 2 };
    const withUnicode = { ...input, payload: { ...input.payload, unicodeKeys } };
    const reordered = {
      ...input,
      payload: { unicodeKeys: { "é": 2, "é": 1 }, a: { x: [3, 2, 1], y: 1 }, z: 2 },
    };
    expect(canonicalJson(withUnicode)).toBe(canonicalJson(reordered));
    const encoded = encodeWorkerArtifact(withUnicode);
    const second = encodeWorkerArtifact(reordered);
    expect(encoded.checksum).toBe(second.checksum);
    expect(decodeWorkerArtifact(encoded.content, encoded.checksum)).toEqual(WorkerInputSchema.parse(withUnicode));
  });

  it("checksum 변조와 비유한 수를 거부한다", () => {
    const encoded = encodeWorkerArtifact(input);
    expect(() => decodeWorkerArtifact(encoded.content, "0".repeat(64))).toThrow("checksum");
    expect(() => decodeWorkerArtifact(encoded.content, encoded.checksum, {
      byteCount: encoded.byteCount,
      uncompressedByteCount: encoded.uncompressedByteCount + 1,
    })).toThrow("metadata");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("유한한 숫자");
  });

  it("TypeScript와 공개 JSON Schema의 job kind 목록이 일치한다", () => {
    const inputSchema = JSON.parse(readFileSync(new URL("../../contracts/worker/input.schema.json", import.meta.url), "utf8"));
    const outputSchema = JSON.parse(readFileSync(new URL("../../contracts/worker/output.schema.json", import.meta.url), "utf8"));
    const expected = [...WorkerJobKindSchema.options];
    expect(inputSchema.$defs.job_kind.enum).toEqual(expected);
    expect(outputSchema.properties.job_kind.enum).toEqual(expected);
    expect(Object.keys(outputSchema.properties)).toEqual(expect.arrayContaining([
      "data_revision",
      "request_hash",
      "payload_hash",
    ]));
  });
});
