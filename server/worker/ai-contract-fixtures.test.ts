import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AiRequestSchema } from "./ai-contract.js";

type JsonObject = Record<string, unknown>;
type PathPart = string | number;
type Mutation =
  | { op: "set"; path: PathPart[]; value: unknown }
  | { op: "remove_last"; path: PathPart[] }
  | { op: "duplicate_item"; path: PathPart[]; index: number };
type InvalidFixture = {
  base: string;
  mutation: Mutation;
};

const fixtureRoot = resolve(process.cwd(), "contracts/scalping-ai");
const validRoot = resolve(fixtureRoot, "valid");
const invalidRoot = resolve(fixtureRoot, "invalid");
const jsonFiles = (directory: string) => readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function atPath(root: unknown, path: PathPart[]): unknown {
  return path.reduce<unknown>((current, part) => {
    if (current === null || typeof current !== "object") {
      throw new Error(`fixture path ${path.join(".")} is not an object path`);
    }
    return (current as Record<PathPart, unknown>)[part];
  }, root);
}

function materializeInvalidFixture(name: string): unknown {
  const fixture = readJson(resolve(invalidRoot, name)) as InvalidFixture;
  const request = structuredClone(readJson(resolve(validRoot, fixture.base)));
  const parentPath = fixture.mutation.path.slice(0, -1);
  const key = fixture.mutation.path.at(-1);

  if (fixture.mutation.op === "set") {
    if (key === undefined) {
      throw new Error(`${name}: set mutation requires a non-empty path`);
    }
    const parent = atPath(request, parentPath);
    if (parent === null || typeof parent !== "object") {
      throw new Error(`${name}: set mutation parent is not an object`);
    }
    (parent as Record<PathPart, unknown>)[key] = fixture.mutation.value;
    return request;
  }

  const target = atPath(request, fixture.mutation.path);
  if (!Array.isArray(target)) {
    throw new Error(`${name}: ${fixture.mutation.op} mutation target is not an array`);
  }
  if (fixture.mutation.op === "remove_last") {
    target.pop();
  } else {
    target.push(structuredClone(target[fixture.mutation.index]));
  }
  return request;
}

describe("shared scalping AI request fixture parity", () => {
  it.each(jsonFiles(validRoot))("accepts shared valid fixture %s", (name) => {
    expect(AiRequestSchema.safeParse(readJson(resolve(validRoot, name))).success).toBe(true);
  });

  it.each(jsonFiles(invalidRoot))("rejects shared invalid fixture %s", (name) => {
    expect(AiRequestSchema.safeParse(materializeInvalidFixture(name)).success).toBe(false);
  });

  it("covers the cross-language causal contract inventory", () => {
    expect(jsonFiles(validRoot)).toEqual(["evaluate.json", "forecast.json"]);
    expect(jsonFiles(invalidRoot)).toEqual([
      "completed-bar.json",
      "duplicate-instrument-key.json",
      "evaluation-consecutive-future-bars.json",
      "evaluation-origin.json",
      "fixed-horizons.json",
      "fixed-quantiles.json",
      "future-timestamp-count.json",
      "input-end-at.json",
      "schema-version.json",
      "strictly-increasing-bars.json",
      "target-stop-bounds.json",
      "timezone-aware-timestamp.json",
      "unknown-field.json",
    ]);
  });
});
