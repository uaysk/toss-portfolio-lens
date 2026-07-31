import { z } from "zod";
import {
  AiRequestSchema,
  AiResponseSchema,
  CHRONOS_2_MODEL_ID,
  FINCAST_MODEL_ID,
} from "./ai-contract.js";

export const SCALPING_AI_TRANSPORT_VERSION = "scalping-ai-ws/v2" as const;
export const SCALPING_AI_WEBSOCKET_PATH = "/ws/scalping-ai/v2" as const;
export const SCALPING_AI_WEBSOCKET_SUBPROTOCOL = "scalping-ai-ws.v2" as const;

const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const transportBase = {
  transport_version: z.literal(SCALPING_AI_TRANSPORT_VERSION),
  request_id: requestId,
};

export const AiTransportRequestEnvelopeSchema = z.object({
  ...transportBase,
  type: z.literal("request"),
  payload: AiRequestSchema,
}).strict().superRefine((envelope, context) => {
  if (envelope.payload.request_id !== envelope.request_id) {
    context.addIssue({ code: "custom", path: ["payload", "request_id"], message: "must equal envelope request_id" });
  }
});

export const AiTransportResponseEnvelopeSchema = z.object({
  ...transportBase,
  type: z.literal("response"),
  payload: AiResponseSchema,
}).strict().superRefine((envelope, context) => {
  if (envelope.payload.request_id !== envelope.request_id) {
    context.addIssue({ code: "custom", path: ["payload", "request_id"], message: "must equal envelope request_id" });
  }
});

export const AiTransportCancelEnvelopeSchema = z.object({
  ...transportBase,
  type: z.literal("cancel"),
}).strict();

export const AiTransportStatusEnvelopeSchema = z.object({
  ...transportBase,
  type: z.literal("status"),
}).strict();

export const AiWorkerStatusSchema = z.object({
  status: z.enum(["available", "degraded", "unavailable"]),
  model: z.object({
    loaded: z.boolean(),
    device: z.enum(["cuda", "cpu", "unavailable"]),
    model_id: z.enum([FINCAST_MODEL_ID, CHRONOS_2_MODEL_ID]),
    model_revision: z.string().min(1).max(256),
    precision: z.enum(["float32", "mixed_float16"]).optional(),
    precision_validation: z.enum(["not_required", "passed", "fallback_fp32", "unavailable"]).optional(),
    memory_status: z.enum(["ok", "memory_pressure", "unavailable"]).optional(),
    quantile_monotonicity_policy: z.enum([
      "native",
      "fp32_monotone_rearrangement_v1",
      "chronos2_fp32_monotone_rearrangement_v1",
      "unavailable",
    ]).optional(),
    quantile_tail_policy: z.enum(["native", "tail_clamped_q10_q90", "unavailable"]).optional(),
  }).strict(),
  active_requests: z.number().int().nonnegative(),
  queued_requests: z.number().int().nonnegative(),
  generated_at: z.string().max(64).refine((value) => (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
  ), "RFC3339 timestamp with offset is required"),
}).strict().superRefine((worker, context) => {
  if (worker.model.loaded === (worker.model.device === "unavailable")) {
    context.addIssue({
      code: "custom",
      path: ["model", "device"],
      message: "loaded worker status requires an execution device",
    });
  }
  if (worker.model.precision === "mixed_float16" && worker.model.precision_validation !== "passed") {
    context.addIssue({
      code: "custom",
      path: ["model", "precision_validation"],
      message: "mixed_float16 worker status requires passed precision validation",
    });
  }
  if (worker.model.memory_status === "memory_pressure"
    && (worker.status !== "unavailable" || worker.model.loaded)) {
    context.addIssue({
      code: "custom",
      path: ["model", "memory_status"],
      message: "memory_pressure must fail closed with an unavailable unloaded worker",
    });
  }
  if (worker.model.model_id === CHRONOS_2_MODEL_ID) {
    const fieldsPresent = worker.model.precision !== undefined
      && worker.model.precision_validation !== undefined
      && worker.model.memory_status !== undefined
      && worker.model.quantile_monotonicity_policy !== undefined
      && worker.model.quantile_tail_policy !== undefined;
    const validLoaded = worker.model.loaded
      && worker.model.precision === "float32"
      && worker.model.precision_validation === "not_required"
      && worker.model.memory_status === "ok"
      && worker.model.quantile_monotonicity_policy === "chronos2_fp32_monotone_rearrangement_v1"
      && worker.model.quantile_tail_policy === "native";
    const validUnavailable = !worker.model.loaded
      && worker.model.precision === "float32"
      && worker.model.precision_validation === "unavailable"
      && worker.model.memory_status === "unavailable"
      && worker.model.quantile_monotonicity_policy === "unavailable"
      && worker.model.quantile_tail_policy === "unavailable";
    if (!fieldsPresent || (!validLoaded && !validUnavailable)) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Chronos-2 worker status requires native FP32 and monotone quantile provenance",
      });
    }
  }
  if (worker.model.model_id === FINCAST_MODEL_ID) {
    const fieldsPresent = worker.model.precision !== undefined
      && worker.model.precision_validation !== undefined
      && worker.model.memory_status !== undefined
      && worker.model.quantile_monotonicity_policy !== undefined
      && worker.model.quantile_tail_policy !== undefined;
    const validLoaded = worker.model.loaded && (
      (worker.model.precision === "mixed_float16" && worker.model.precision_validation === "passed")
      || (worker.model.precision === "float32" && worker.model.precision_validation === "fallback_fp32")
    ) && worker.model.memory_status === "ok"
      && worker.model.quantile_monotonicity_policy === "fp32_monotone_rearrangement_v1"
      && worker.model.quantile_tail_policy === "tail_clamped_q10_q90";
    const validUnavailable = !worker.model.loaded
      && worker.model.precision === "float32"
      && worker.model.precision_validation === "unavailable"
      && (worker.model.memory_status === "unavailable" || worker.model.memory_status === "memory_pressure")
      && worker.model.quantile_monotonicity_policy === "unavailable"
      && worker.model.quantile_tail_policy === "unavailable";
    if (!fieldsPresent || (!validLoaded && !validUnavailable)) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "FinCast worker status requires complete precision and memory provenance",
      });
    }
  }
});

export const AiTransportStatusResponseEnvelopeSchema = z.object({
  ...transportBase,
  type: z.literal("status_response"),
  status: AiWorkerStatusSchema,
}).strict();

export const AiClientTransportEnvelopeSchema = z.discriminatedUnion("type", [
  AiTransportRequestEnvelopeSchema,
  AiTransportCancelEnvelopeSchema,
  AiTransportStatusEnvelopeSchema,
]);

export const AiServerTransportEnvelopeSchema = z.discriminatedUnion("type", [
  AiTransportResponseEnvelopeSchema,
  AiTransportStatusResponseEnvelopeSchema,
]);

export type AiTransportRequestEnvelope = z.infer<typeof AiTransportRequestEnvelopeSchema>;
export type AiTransportResponseEnvelope = z.infer<typeof AiTransportResponseEnvelopeSchema>;
export type AiTransportCancelEnvelope = z.infer<typeof AiTransportCancelEnvelopeSchema>;
export type AiTransportStatusEnvelope = z.infer<typeof AiTransportStatusEnvelopeSchema>;
export type AiTransportStatusResponseEnvelope = z.infer<typeof AiTransportStatusResponseEnvelopeSchema>;
export type AiWorkerStatus = z.infer<typeof AiWorkerStatusSchema>;
export type AiClientTransportEnvelope = z.infer<typeof AiClientTransportEnvelopeSchema>;
export type AiServerTransportEnvelope = z.infer<typeof AiServerTransportEnvelopeSchema>;
