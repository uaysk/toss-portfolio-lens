import { describe, expect, it } from "vitest";
import type { ArtifactRepository } from "../repositories/artifact-repository.js";
import { ArtifactService } from "./artifact-service.js";

function service(maximumRows = 10, maximumBytes = 32): ArtifactService {
  return new ArtifactService({} as ArtifactRepository, maximumRows, maximumBytes);
}

describe("ArtifactService", () => {
  it("externalizes at the exact row and canonical byte boundaries", () => {
    const artifacts = service(2, 7);

    expect(artifacts.shouldExternalize([1, 2])).toBe(false);
    expect(artifacts.shouldExternalize([1, 2, 3])).toBe(true);
    expect(artifacts.shouldExternalize({ a: 1 })).toBe(false);
    expect(artifacts.shouldExternalize({ ab: 1 })).toBe(true);
  });

  it("uses canonical UTF-8 sizing and stops once a large value crosses the limit", () => {
    const artifacts = service(10, 16);

    expect(artifacts.shouldExternalize({ value: "한" })).toBe(false);
    expect(artifacts.shouldExternalize({ value: "한글" })).toBe(true);
  });

  it("short-circuits byte inspection when the row limit already externalizes the value", () => {
    const artifacts = service(0, 1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(artifacts.shouldExternalize(circular, 1)).toBe(true);
  });
});
