import type { Ticket } from "./ticket.js";

/**
 * Convert an arbitrary string to a URL-safe slug.
 * Rules (from phase-contracts spec):
 *   - lowercase
 *   - runs of non-[a-z0-9] → single '-'
 *   - trim leading/trailing '-'
 *   - truncate to 50 chars and re-trim trailing '-'
 */
export function slugify(title: string): string {
  const lowered = title.toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  const truncated = trimmed.slice(0, 50);
  return truncated.replace(/-+$/g, "");
}

/**
 * Deterministic branch name for a ticket.
 * Format: `night-shift/<id>-<slug>`
 *
 * Edge case: if `title` produces an empty slug (e.g. "!!!"), the result is
 * `night-shift/<id>` with no trailing dash. This is intentional — we'd
 * rather have a usable branch name than reject the ticket at this layer.
 */
export function branchNameFor(ticket: Pick<Ticket, "id" | "title">): string {
  const slug = slugify(ticket.title);
  return slug.length > 0
    ? `night-shift/${ticket.id}-${slug}`
    : `night-shift/${ticket.id}`;
}

/**
 * Derive a deterministic change name from an issue title and number.
 * Uses `slugify(title)` and appends `-<issueNumber>` for uniqueness.
 * When the title produces an empty slug, returns just `String(issueNumber)`.
 */
export function deriveChangeName(title: string, issueNumber: number): string {
  const slug = slugify(title);
  return slug.length > 0 ? `${slug}-${issueNumber}` : String(issueNumber);
}

/**
 * Convert decimal USD (e.g. 0.0123) to integer micro-USD (12300).
 * Rounded to nearest integer; negative inputs throw.
 */
export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`usdToMicro: expected non-negative finite number, got ${usd}`);
  }
  return Math.round(usd * 1_000_000);
}

/**
 * Convert integer micro-USD back to decimal USD.
 */
export function microToUsd(micro: number): number {
  if (!Number.isInteger(micro) || micro < 0) {
    throw new RangeError(`microToUsd: expected non-negative integer, got ${micro}`);
  }
  return micro / 1_000_000;
}
