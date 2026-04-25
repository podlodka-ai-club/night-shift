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
  maxIterations: z.number().int().positive().optional(),
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
 *   - errors present before the final configured iteration → "needs-fix"
 *   - errors present on the final configured iteration     → "escalate"
 *
 * Warnings never block and never change the verdict.
 * `maxIterations` counts review attempts, not fix loops. With the default of
 * 3, iterations 0 and 1 trigger re-implementation and iteration 2 escalates.
 */
export function decideVerdict(
  findings: Finding[],
  iteration: number,
  maxIterations: number = 3,
): Verdict {
  const hasErrors = findings.some((f) => f.severity === "error");
  if (!hasErrors) return "ready-to-merge";
  return iteration + 1 < maxIterations ? "needs-fix" : "escalate";
}
