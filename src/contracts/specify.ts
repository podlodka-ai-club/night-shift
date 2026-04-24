import { z } from "zod";
import { TicketSchema, type Ticket } from "./ticket.js";
import { branchNameFor } from "./helpers.js";

export const SpecifyInputSchema = z.object({
  ticket: TicketSchema,
});
export type SpecifyInput = z.infer<typeof SpecifyInputSchema>;

/**
 * Output of the Specify phase.
 * - `specPath` is an absolute path inside the working repository to the
 *   OpenSpec change folder produced by the specifier agent.
 * - `branch` must equal `branchNameFor(ticket)`; enforced by
 *   `validateSpecBundle`.
 * - `openQuestions`, `assumptions`, `risks` are surfaced to a human reviewer
 *   in the ticket description.
 * - `commitSha` identifies the commit that introduced the specs on `branch`.
 */
export const SpecBundleSchema = z.object({
  specPath: z.string().min(1),
  branch: z.string().min(1),
  openQuestions: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/, "commitSha must be a hex SHA"),
});
export type SpecBundle = z.infer<typeof SpecBundleSchema>;

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Cross-field validation: the bundle's branch must match the deterministic
 * name derived from the ticket. This catches drift between specifier agent
 * output and downstream phases.
 */
export function validateSpecBundle(ticket: Ticket, bundle: SpecBundle): ValidationResult {
  const expected = branchNameFor(ticket);
  if (bundle.branch !== expected) {
    return {
      ok: false,
      error: `SpecBundle.branch "${bundle.branch}" does not match expected "${expected}" for ticket ${ticket.id}`,
    };
  }
  return { ok: true };
}
