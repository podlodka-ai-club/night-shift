import { z } from "zod";

/**
 * Closed enum of ticket statuses used across Night Shift's baseline flow.
 * Values mirror the GitHub Projects v2 single-select column labels.
 */
export const TICKET_STATUSES = [
  "Backlog",
  "Refinement",
  "Refined",
  "Ready",
  "In progress",
  "In review",
  "Ready to merge",
] as const;

export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/**
 * Allowed (from, to) transitions. The orchestrator enforces these;
 * this module only declares them.
 *
 *   Backlog -> Refinement -> Refined -> Ready -> In progress -> In review -> Ready to merge
 *
 * Plus two escalation edges from `In review`:
 *   In review -> Refinement  (reviewer found a spec-level problem)
 *   In review -> Ready       (reviewer escalated mid-implementation defects back to implement)
 */
export const TICKET_STATUS_TRANSITIONS: readonly (readonly [
  TicketStatus,
  TicketStatus,
])[] = [
  ["Backlog", "Refinement"],
  ["Refinement", "Refined"],
  ["Refined", "Ready"],
  ["Ready", "In progress"],
  ["In progress", "In review"],
  ["In review", "Ready to merge"],
  ["In review", "Refinement"],
  ["In review", "Ready"],
] as const;

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  for (const [f, t] of TICKET_STATUS_TRANSITIONS) {
    if (f === from && t === to) return true;
  }
  return false;
}
