import { z } from "zod";
import type { Portfolio } from "../toss.js";

export const PORTFOLIO_EVENT_SCHEMA_VERSION = 1 as const;

export const PortfolioEventTypeSchema = z.enum([
  "snapshot",
  "changed",
  "heartbeat",
]);
export type PortfolioEventType = z.infer<typeof PortfolioEventTypeSchema>;

export const PortfolioEventV1Schema = z.object({
  schemaVersion: z.literal(PORTFOLIO_EVENT_SCHEMA_VERSION),
  accountId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  emittedAt: z.string().datetime({ offset: true }),
  type: PortfolioEventTypeSchema,
  payload: z.unknown().nullable(),
}).strict();

export type PortfolioEventV1 = Omit<
  z.infer<typeof PortfolioEventV1Schema>,
  "payload"
> & {
  payload: Portfolio | null;
};
