/**
 * formatter_json.ts – Stable JSON renderer for RunSummary.
 *
 * Emits a single JSON object with canonical keys in declaration order.
 * `budget` is omitted when null/undefined (see RunSummary definition).
 * No trailing log lines are appended; callers receive exactly one JSON object.
 *
 * Canonical keys:
 *   ticket_title      string
 *   stages_completed  string[]
 *   elapsed_seconds   number
 *   cost_used         number
 *   budget            number   (omitted when null/undefined)
 *   status            string
 */

import type { RunSummary } from './summarizer.js';

/** Shape of the emitted JSON object. */
interface RunSummaryJson {
  ticket_title: string;
  stages_completed: string[];
  elapsed_seconds: number;
  cost_used: number;
  budget?: number;
  status: string;
}

/**
 * Serialises `summary` to an indented JSON string terminated by a newline.
 *
 * The field order is deterministic (matches `RunSummaryJson` declaration).
 * `budget` is omitted when `summary.budget` is null or undefined.
 */
export function emitJson(summary: RunSummary): string {
  const obj: RunSummaryJson = {
    ticket_title: summary.ticketTitle,
    stages_completed: summary.stagesCompleted,
    elapsed_seconds: summary.elapsedSeconds,
    cost_used: summary.costUsed,
    ...(summary.budget != null ? { budget: summary.budget } : {}),
    status: summary.finalStatus,
  };
  return JSON.stringify(obj, null, 2) + '\n';
}
