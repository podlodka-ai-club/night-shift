import { z } from "zod";
import { TicketSchema } from "./ticket.js";
import { SpecBundleSchema } from "./specify.js";

export const QualityGateStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type QualityGateStatus = z.infer<typeof QualityGateStatusSchema>;

/**
 * One quality-gate run result (e.g. `tsc --noEmit`, `vitest run`, lint).
 * `logsTail` is a truncated excerpt (max 4 KiB, see design D in proposal);
 * full logs live at `logsPath` if persisted.
 */
export const QualityGateResultSchema = z.object({
  name: z.string().min(1),
  status: QualityGateStatusSchema,
  durationMs: z.number().int().nonnegative(),
  logsTail: z.string().max(4096).optional(),
  logsPath: z.string().optional(),
});
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

export const PRRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/),
});
export type PRRef = z.infer<typeof PRRefSchema>;

export const ImplementInputSchema = z.object({
  ticket: TicketSchema,
  specBundle: SpecBundleSchema,
});
export type ImplementInput = z.infer<typeof ImplementInputSchema>;

export const ImplementationResultSchema = z.object({
  pr: PRRefSchema,
  qualityGates: z.array(QualityGateResultSchema),
  specReview: z.object({
    subagentSummary: z.string(),
    blockingIssues: z.array(z.string()),
  }),
  summary: z.string(),
});
export type ImplementationResult = z.infer<typeof ImplementationResultSchema>;
