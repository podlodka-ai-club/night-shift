import { z } from "zod";

export const PhaseSchema = z.enum(["specify", "implement", "review"]);
export type Phase = z.infer<typeof PhaseSchema>;

/**
 * ISO-8601 timestamp as string. We intentionally do not accept Date objects:
 * contracts must round-trip through JSON unchanged.
 */
const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
    "ts must be an ISO-8601 timestamp string",
  );

/**
 * Cost is expressed in micro-USD (integer) across all events to avoid
 * floating-point accumulation. Convert with `usdToMicro` / `microToUsd`.
 */
const CostMicroUsdSchema = z.number().int().nonnegative();

/** Token usage for an agent call. */
const TokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

/**
 * Common fields every PhaseEvent variant carries. Kept as a raw shape so
 * each variant can spread it into its own `z.object({...})`.
 */
const PhaseEventCommon = {
  ticketId: z.string().min(1),
  phase: PhaseSchema,
  profileId: z.string().min(1),
  ts: IsoTimestampSchema,
  runId: z.string().min(1),
} as const;

export const PhaseStartedSchema = z.object({
  kind: z.literal("PhaseStarted"),
  ...PhaseEventCommon,
  inputSummary: z.string(),
});
export type PhaseStarted = z.infer<typeof PhaseStartedSchema>;

export const PhaseCompletedSchema = z.object({
  kind: z.literal("PhaseCompleted"),
  ...PhaseEventCommon,
  outputSummary: z.string(),
  durationMs: z.number().int().nonnegative(),
  cost: CostMicroUsdSchema,
  tokens: TokensSchema,
});
export type PhaseCompleted = z.infer<typeof PhaseCompletedSchema>;

export const PhaseFailedSchema = z.object({
  kind: z.literal("PhaseFailed"),
  ...PhaseEventCommon,
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  durationMs: z.number().int().nonnegative(),
});
export type PhaseFailed = z.infer<typeof PhaseFailedSchema>;

export const AgentInvokedSchema = z.object({
  kind: z.literal("AgentInvoked"),
  ...PhaseEventCommon,
  role: z.enum(["specifier", "implementer", "reviewer", "subagent"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  cost: CostMicroUsdSchema,
  tokens: TokensSchema,
  latencyMs: z.number().int().nonnegative(),
});
export type AgentInvoked = z.infer<typeof AgentInvokedSchema>;

export const QualityGateEvaluatedSchema = z.object({
  kind: z.literal("QualityGateEvaluated"),
  ...PhaseEventCommon,
  gate: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().int().nonnegative(),
});
export type QualityGateEvaluated = z.infer<typeof QualityGateEvaluatedSchema>;

export const PhaseEventSchema = z.discriminatedUnion("kind", [
  PhaseStartedSchema,
  PhaseCompletedSchema,
  PhaseFailedSchema,
  AgentInvokedSchema,
  QualityGateEvaluatedSchema,
]);
export type PhaseEvent = z.infer<typeof PhaseEventSchema>;

/**
 * Sink for observability events. Implementations: stdout, file, Temporal
 * heartbeat, etc. — all live in `orchestration-runtime`. This module only
 * declares the interface.
 */
export interface EventSink {
  emit(event: PhaseEvent): void | Promise<void>;
}
