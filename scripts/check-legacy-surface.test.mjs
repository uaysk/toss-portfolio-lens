import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findLegacyViolations,
  FORBIDDEN_LEGACY_TERMS,
} from "./check-legacy-surface.mjs";

describe("legacy surface guard", () => {
  it("reports every forbidden term with a stable line", () => {
    const contents = [
      "safe",
      FORBIDDEN_LEGACY_TERMS[0],
      `prefix ${FORBIDDEN_LEGACY_TERMS.at(-1)} suffix`,
    ].join("\n");
    assert.deepEqual(findLegacyViolations("server/example.ts", contents), [
      { path: "server/example.ts", line: 2, term: FORBIDDEN_LEGACY_TERMS[0] },
      { path: "server/example.ts", line: 3, term: FORBIDDEN_LEGACY_TERMS.at(-1) },
    ]);
  });

  it("accepts current contract vocabulary", () => {
    assert.deepEqual(
      findLegacyViolations(
        "server/example.ts",
        "POSTGRES_HOST\nrust_socket\nAI_FINCAST_URL\nAI_CHRONOS2_URL\n--no-synthesis",
      ),
      [],
    );
  });
});
