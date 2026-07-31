import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseEnv } from "node:util";
import { ensureReadOnlyApiToken } from "./ensure-read-only-api-token.mjs";

const directories = [];

function fixture(contents) {
  const directory = mkdtempSync(join(tmpdir(), "tpl-token-test-"));
  directories.push(directory);
  const path = join(directory, ".env");
  writeFileSync(path, contents, { mode: 0o644 });
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("read-only API token provisioning", () => {
  it("adds a distinct token without exposing or duplicating the key", () => {
    const path = fixture("DASHBOARD_PASSWORD=dashboard-secret\nPORT=3200\n");
    const token = "r".repeat(48);
    const result = ensureReadOnlyApiToken(path, () => token);
    const contents = readFileSync(path, "utf8");
    const values = parseEnv(contents);
    assert.deepEqual(result, { changed: true, length: 48 });
    assert.equal(values.READ_ONLY_API_TOKEN, token);
    assert.equal(contents.match(/^READ_ONLY_API_TOKEN=/gmu)?.length, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("preserves an existing compliant token", () => {
    const token = "t".repeat(48);
    const path = fixture(
      `DASHBOARD_PASSWORD=dashboard-secret\nREAD_ONLY_API_TOKEN=${token}\n`,
    );
    assert.deepEqual(
      ensureReadOnlyApiToken(path, () => {
        throw new Error("must not rotate");
      }),
      { changed: false, length: 48 },
    );
  });

  it("rejects a generated dashboard-password duplicate", () => {
    const path = fixture("DASHBOARD_PASSWORD=duplicate-secret-that-is-long-enough\n");
    assert.throws(
      () => ensureReadOnlyApiToken(path, () => "duplicate-secret-that-is-long-enough"),
      /security policy/u,
    );
  });
});
