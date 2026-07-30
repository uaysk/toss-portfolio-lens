import { createHash } from "node:crypto";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  writeFinCastRawInputArtifact,
  type FinCastRawInputRow,
} from "./fincast-raw-artifact.js";

function rows(count = 2): FinCastRawInputRow[] {
  return Array.from({ length: count }, (_unused, rowId) => {
    const origin = Date.UTC(2026, 6, 1, 0, rowId);
    return {
      instrumentKey: `BINANCE_USDM:BTCUSDT:${rowId}`,
      origin: new Date(origin).toISOString(),
      futureTimestamps: Array.from(
        { length: 60 },
        (_future, index) => new Date(origin + (index + 1) * 60_000).toISOString(),
      ),
      closes: Array.from({ length: 512 }, (_close, index) => 60_000 + rowId + index / 10),
      metadata: { symbol: "BTCUSDT", ordinal: rowId },
    };
  });
}

describe("FinCast raw input artifact", () => {
  it("writes bounded little-endian closes, non-price origins, and matching digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "fincast-raw-"));
    const directory = join(root, "input");
    const artifact = await writeFinCastRawInputArtifact({
      directory,
      cadenceSeconds: 60,
      modelSeed: 17,
      rows: rows(),
      metadata: { source: "unit-test" },
    });
    const contexts = await readFile(join(directory, "contexts.f32"));
    const origins = await readFile(join(directory, "origins.jsonl"), "utf8");
    const firstOrigin = JSON.parse(origins.split("\n")[0]!) as Record<string, unknown>;

    expect(artifact.manifest.schema_version).toBe("fincast-raw-input/v1");
    expect(artifact.manifest.row_count).toBe(2);
    expect(contexts.byteLength).toBe(2 * 512 * 4);
    expect(contexts.readFloatLE(0)).toBeCloseTo(60_000);
    expect(createHash("sha256").update(contexts).digest("hex"))
      .toBe(artifact.manifest.files.contexts.sha256);
    expect(firstOrigin).not.toHaveProperty("closes");
    expect(firstOrigin).not.toHaveProperty("close");
    expect(firstOrigin.row_id).toBe(0);
  });

  it("rejects price metadata, malformed rows, symlinks, and non-empty outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fincast-raw-invalid-"));
    await expect(writeFinCastRawInputArtifact({
      directory: join(root, "price"),
      cadenceSeconds: 15,
      modelSeed: 1,
      rows: [{ ...rows(1)[0]!, metadata: { close: 1 } }],
    })).rejects.toThrow(/price field/);

    await expect(writeFinCastRawInputArtifact({
      directory: join(root, "short"),
      cadenceSeconds: 30,
      modelSeed: 1,
      rows: [{ ...rows(1)[0]!, closes: [1] }],
    })).rejects.toThrow(/512 closes/);

    const target = join(root, "target");
    await writeFinCastRawInputArtifact({
      directory: target,
      cadenceSeconds: 60,
      modelSeed: 1,
      rows: rows(1),
    });
    await expect(writeFinCastRawInputArtifact({
      directory: target,
      cadenceSeconds: 60,
      modelSeed: 1,
      rows: rows(1),
    })).rejects.toThrow(/must be empty/);

    const linked = join(root, "linked");
    await symlink(target, linked);
    await expect(writeFinCastRawInputArtifact({
      directory: linked,
      cadenceSeconds: 60,
      modelSeed: 1,
      rows: rows(1),
    })).rejects.toThrow(/symlink/);
  });
});
