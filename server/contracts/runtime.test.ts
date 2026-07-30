import { describe, expect, it } from "vitest";
import {
  LEGACY_DURABLE_COMPUTE_MODULE,
  RuntimeModuleDescriptorV1Schema,
} from "./runtime.js";

describe("runtime lifecycle contracts", () => {
  it("keeps the legacy durable compute path explicitly deprecated", () => {
    expect(RuntimeModuleDescriptorV1Schema.parse(LEGACY_DURABLE_COMPUTE_MODULE))
      .toEqual(LEGACY_DURABLE_COMPUTE_MODULE);
  });
});
