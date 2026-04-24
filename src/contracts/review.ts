import { z } from "zod";
import { TicketSchema } from "./ticket.js";
import { SpecBundleSchema } from "./specify.js";
import { PRRefSchema } from "./implement.js";

export const FindingSeveritySchema = z.enum(["error", "warning"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  message: z.string().min(1),
  location: z
    .object({
      file: z.string().min(1),
      line: z.number().int().positive().optional(),
    })
    .optional(),
  specRef: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.enum(["ready-to-merge", "needs-fix", "escalate"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ReviewInputSchema = z.object({
  ticket: TicketSchema,
  specBundle: SpecBundleSchema,
  pr: PRRefSchema,
  iteration: z.number().int().nonnegative(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const ReviewResultSchema = z.object({
  verdict: VerdictSchema,
  findings: z.array(FindingSchema),
  iteration: z.number().int().nonnegative(),
  summary: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * Verdict rules (pure):
 *   - no error-level findings        → "ready-to-merge"
 *   - errors present, iteration < 2  → "needs-fix"   (implementer gets another chance)
 *   - errors present, iteration ≥ 2  → "escalate"    (human takes over)
 *
 * Warnings never block and never change the verdict.
 * The maximum of two fix loops corresponds to iterations 0 and 1 triggering
 * a re-implementation; on iteration 2 the reviewer escalates.
 */
export function decideVerdict(findings: Finding[], iteration: number): Verdict {
  const hasErrors = findings.some((f) => f.severity === "error");
  if (!hasErrors) return "ready-to-merge";
  return iteration < 2 ? "needs-fix" : "escalate";
}
