import { z } from "zod";

export const RuntimeModuleLifecycleSchema = z.enum([
  "active",
  "deprecated",
  "retired",
]);

export type RuntimeModuleLifecycle = z.infer<typeof RuntimeModuleLifecycleSchema>;

export const RuntimeModuleDescriptorV1Schema = z.object({
  schemaVersion: z.literal(1),
  module: z.string().trim().min(1).max(120),
  lifecycle: RuntimeModuleLifecycleSchema,
  replacement: z.string().trim().min(1).max(120).optional(),
  removalGate: z.string().trim().min(1).max(240).optional(),
}).strict();

export type RuntimeModuleDescriptorV1 = z.infer<typeof RuntimeModuleDescriptorV1Schema>;

export const LEGACY_DURABLE_COMPUTE_MODULE = Object.freeze({
  schemaVersion: 1,
  module: "worker/python",
  lifecycle: "deprecated",
  replacement: "worker/rust",
  removalGate: "one healthy Harbor release plus 14 days of observation",
} as const satisfies RuntimeModuleDescriptorV1);
