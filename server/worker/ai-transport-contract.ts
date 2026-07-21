import { z } from "zod";
import { AiRequestSchema, AiResponseSchema } from "./ai-contract.js";

export const SCALPING_AI_TRANSPORT_VERSION = "scalping-ai-ws/v1" as const;
export const SCALPING_AI_WEBSOCKET_PATH = "/ws/scalping-ai/v1" as const;
export const SCALPING_AI_WEBSOCKET_SUBPROTOCOL = "scalping-ai-ws.v1" as const;

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
    model_id: z.string().min(1).max(256),
    model_revision: z.string().min(1).max(256),
  }).strict(),
  active_requests: z.number().int().nonnegative(),
  queued_requests: z.number().int().nonnegative(),
  generated_at: z.string().max(64).refine((value) => (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
  ), "RFC3339 timestamp with offset is required"),
}).strict();

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
