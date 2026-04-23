/**
 * formatter_pretty.ts – Pretty-print renderer for RunSummary.
 *
 * Produces a compact single-block table containing:
 *   Ticket | Stages | Duration | Cost (used/budget)
 *   Status row
 *
 * Uses only Node.js built-ins (no extra dependencies).
 * ANSI colour codes are emitted only when `opts.color` is true.
 */

import type { RunSummary, EmitOptions } from './summarizer.js';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

/** Wraps `text` in an ANSI sequence when `useColor` is true, otherwise passes through. */
function colorize(text: string, code: string, useColor: boolean): string {
  if (!useColor) return text;
  return `${code}${text}${ANSI.reset}`;
}

// ─── Duration helper ──────────────────────────────────────────────────────────

/**
 * Converts an elapsed-seconds value to an `HH:MM:SS` string.
 *
 * @example durationToHHMMSS(433) → "00:07:13"
 */
export function durationToHHMMSS(elapsedSeconds: number): string {
  const total = Math.max(0, Math.round(elapsedSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

// ─── Stage list trimming ──────────────────────────────────────────────────────

/**
 * Returns an arrow-separated stage list trimmed to `maxWidth` characters.
 * When the list exceeds `maxWidth`, shows first `n` and last `n` stages with
 * `…` in the middle (e.g. "validate → build → … → deploy").
 *
 * @param stages    Ordered stage names.
 * @param maxWidth  Maximum character width of the result string.
 * @param n         Number of stages to keep at each end (default 2).
 */
export function trimStageList(stages: string[], maxWidth: number, n = 2): string {
  if (stages.length === 0) return '—';
  const sep = ' → ';
  const full = stages.join(sep);
  if (full.length <= maxWidth) return full;

  // Try progressively smaller n values until we fit.
  for (let k = n; k >= 1; k--) {
    const head = stages.slice(0, k);
    const tail = stages.slice(-k);

    // Avoid duplication when stages list is very short.
    if (head[head.length - 1] === tail[0]) break;

    const candidate = [...head, '…', ...tail].join(sep);
    if (candidate.length <= maxWidth) return candidate;
  }

  // Last resort: truncate with ellipsis.
  const truncated = full.slice(0, maxWidth - 1);
  return truncated + '…';
}

// ─── Cost string ─────────────────────────────────────────────────────────────

function formatCost(s: RunSummary, useColor: boolean): string {
  const used = `$${s.costUsed.toFixed(2)}`;
  if (s.budget == null) return used;
  const budget = `$${s.budget.toFixed(2)}`;
  const combined = `${used} / ${budget}`;
  if (s.costUsed > s.budget) {
    return colorize(combined, ANSI.red, useColor);
  }
  return combined;
}

// ─── Status colour ────────────────────────────────────────────────────────────

function colorStatus(status: string, useColor: boolean): string {
  if (!useColor) return status;
  switch (status.toLowerCase()) {
    case 'completed': return colorize(status, ANSI.green, useColor);
    case 'blocked':   return colorize(status, ANSI.red, useColor);
    default:          return colorize(status, ANSI.yellow, useColor);
  }
}

// ─── Table builder ────────────────────────────────────────────────────────────

/** Returns a horizontal border string of the given width. */
function border(width: number): string {
  return '+' + '-'.repeat(width - 2) + '+';
}

/** Pads `text` with spaces to exactly `width` characters (no ANSI aware). */
function pad(text: string, width: number): string {
  // Strip ANSI codes for length calculation so padding is consistent.
  const plainLen = text.replace(/\x1b\[[0-9;]*m/g, '').length;
  const extra = width - plainLen;
  return text + (extra > 0 ? ' '.repeat(extra) : '');
}

/**
 * Builds the pretty table string for a RunSummary.
 *
 * Column widths are derived from the terminal width hint (`opts.width`).
 */
export function emitPretty(s: RunSummary, opts: Required<EmitOptions>): string {
  const useColor = opts.color;
  const termWidth = Math.max(60, opts.width);

  // ── Fixed column widths ────────────────────────────────────────────────────
  // Layout:  | Ticket | Stages | Duration | Cost |
  // Borders: 5 pipes + 4 × 2 spaces = 13 chars overhead
  const DURATION_W = 10; // "00:07:13"  + padding
  const COST_W     = 20; // "$12.40 / $20.00" + padding
  const FIXED_COLS = DURATION_W + COST_W;
  const OVERHEAD   = 5 + 4 * 2; // pipes + spaces
  const remaining  = termWidth - FIXED_COLS - OVERHEAD;
  const TICKET_W   = Math.max(16, Math.floor(remaining * 0.45));
  const STAGES_W   = Math.max(16, remaining - TICKET_W);

  const tableWidth = TICKET_W + STAGES_W + DURATION_W + COST_W + OVERHEAD;

  // ── Cell values ───────────────────────────────────────────────────────────
  const ticketText   = s.ticketTitle.length > TICKET_W
    ? s.ticketTitle.slice(0, TICKET_W - 1) + '…'
    : s.ticketTitle;

  const stagesText   = trimStageList(s.stagesCompleted, STAGES_W - 2);
  const durationText = durationToHHMMSS(s.elapsedSeconds);
  const costText     = formatCost(s, useColor);

  // ── Header row ────────────────────────────────────────────────────────────
  const headerTicket   = colorize('Ticket', ANSI.bold, useColor);
  const headerStages   = colorize('Stages', ANSI.bold, useColor);
  const headerDuration = colorize('Duration', ANSI.bold, useColor);
  const headerCost     = colorize('Cost (used/budget)', ANSI.bold, useColor);

  const hBorder = border(tableWidth);
  const hRow = [
    '| ',
    pad(headerTicket, TICKET_W),
    ' | ',
    pad(headerStages, STAGES_W),
    ' | ',
    pad(headerDuration, DURATION_W),
    ' | ',
    pad(headerCost, COST_W),
    ' |',
  ].join('');

  // ── Data row ──────────────────────────────────────────────────────────────
  const dRow = [
    '| ',
    pad(ticketText, TICKET_W),
    ' | ',
    pad(stagesText, STAGES_W),
    ' | ',
    pad(durationText, DURATION_W),
    ' | ',
    pad(costText, COST_W),
    ' |',
  ].join('');

  // ── Status row ────────────────────────────────────────────────────────────
  const statusLabel = `Status: ${colorStatus(s.finalStatus, useColor)}`;
  // Status row spans full width minus 2 border chars.
  const statusCell = '| ' + pad(statusLabel, tableWidth - 4) + ' |';

  const lines = [hBorder, hRow, hBorder, dRow, statusCell, hBorder, ''];
  return lines.join('\n');
}
