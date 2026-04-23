/**
 * summarizer.ts – RunSummary model and EmitRunSummary API.
 *
 * Provides a single structured summary emitted exactly once per run when the
 * run reaches a terminal state (completed | blocked). Two output formats are
 * supported:
 *
 *   - "pretty"  compact ANSI-coloured table for interactive terminals.
 *   - "json"    stable JSON object for machine parsing (CI, tooling).
 *   - "none"    suppresses output entirely.
 *
 * Default format selection (in precedence order):
 *   1. Explicit `EmitOptions.format` value set by the caller.
 *   2. `output.runSummary.format` config key.
 *   3. `CI=true` environment variable → "json".
 *   4. Stdout is a TTY → "pretty".
 *   5. Fallback → "json".
 *
 * Single-emission guarantee:
 *   Callers must gate the call with an atomic flag (e.g. `summaryEmitted`) on
 *   the run-state object so this function is invoked at most once per run.
 *   The function itself is stateless and will emit every time it is called.
 *
 * Security note:
 *   Only fields declared on `RunSummary` are emitted. No secrets, full
 *   payloads, or log buffers are included.
 */

import { emitPretty } from './formatter_pretty.js';
import { emitJson } from './formatter_json.js';
import type { RunState, RunEvent } from '../types.js';
import type { RunStore } from '../store/RunStore.js';
import type { AgentRunner } from '../providers/AgentRunner.js';

// ─── Data model ──────────────────────────────────────────────────────────────

/**
 * RunSummary captures the key metrics of a single orchestrator run.
 *
 * `StartTime` and `EndTime` are used to derive `elapsedSeconds` automatically
 * inside `EmitRunSummary` when `elapsedSeconds` is not already set.
 *
 * `budget` is optional; when absent it is omitted from JSON output.
 */
export interface RunSummary {
  /** Human-readable ticket title (e.g. "FFH-123: Add widget"). */
  ticketTitle: string;
  /** Ordered list of stages the run passed through. */
  stagesCompleted: string[];
  /** Wall-clock start time of the run (used to derive elapsedSeconds). */
  startTime: Date;
  /** Wall-clock end time of the run (used to derive elapsedSeconds). */
  endTime: Date;
  /**
   * Total elapsed wall-clock seconds. Derived from startTime/endTime if zero.
   * Set explicitly to override.
   */
  elapsedSeconds: number;
  /** Total estimated cost in USD. Use 0 when the estimator is unavailable. */
  costUsed: number;
  /** Optional spend budget in USD; omitted from JSON when undefined/null. */
  budget?: number | null;
  /** Terminal status: "completed" | "blocked". */
  finalStatus: string;
}

// ─── Options ─────────────────────────────────────────────────────────────────

/**
 * Controls how `EmitRunSummary` renders the summary.
 *
 * All fields are optional; defaults are applied inside `EmitRunSummary`.
 */
export interface EmitOptions {
  /**
   * Output format.
   *
   *   "pretty"  – human-friendly ANSI table (default on TTY).
   *   "json"    – stable JSON object (default on CI / non-TTY).
   *   "none"    – suppresses output.
   */
  format?: 'pretty' | 'json' | 'none';
  /**
   * Enable ANSI colour codes. Defaults to `true` only when stdout is a TTY
   * and `format` is "pretty". Explicit `false` always disables colour.
   */
  color?: boolean;
  /**
   * Terminal width hint in columns used by the pretty formatter to trim the
   * stage list. Defaults to `process.stdout.columns` or 80 when not set.
   */
  width?: number;
}

// ─── TTY helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when stdout is an interactive terminal.
 * Uses Node.js built-in `process.stdout.isTTY`.
 */
export function isTerminal(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Resolves the effective output format using precedence rules:
 *   CLI flag → config key → CI env → TTY → "json".
 *
 * @param cliFlag    Value of `--summary-format` flag (may be undefined).
 * @param configKey  Value of `output.runSummary.format` config (may be undefined).
 */
export function resolveFormat(
  cliFlag?: string,
  configKey?: string,
): 'pretty' | 'json' | 'none' {
  const valid = (v: string | undefined): v is 'pretty' | 'json' | 'none' =>
    v === 'pretty' || v === 'json' || v === 'none';

  if (valid(cliFlag)) return cliFlag;
  if (valid(configKey)) return configKey;
  if (process.env.CI === 'true' || process.env.CI === '1') return 'json';
  if (isTerminal()) return 'pretty';
  return 'json';
}

// ─── Emit API ─────────────────────────────────────────────────────────────────

/**
 * Emits a formatted run summary to the provided writer.
 *
 * Validates required fields and derives `elapsedSeconds` from
 * `startTime`/`endTime` when the field is 0.  Applies default `EmitOptions`
 * when not supplied.  Returns without writing when `opts.format === "none"`.
 *
 * @param write   Destination writer function (typically `process.stdout.write.bind(process.stdout)`).
 * @param s       The `RunSummary` to emit.
 * @param opts    Rendering options (format, color, width).
 */
export function emitRunSummary(
  write: (chunk: string) => void,
  s: RunSummary,
  opts: EmitOptions = {},
): void {
  // ── Validation ────────────────────────────────────────────────────────────
  if (!s.ticketTitle) {
    // Non-panicking: emit a warning on stderr and proceed.
    process.stderr.write('[summarizer] WARNING: ticketTitle is empty\n');
  }
  if (!Array.isArray(s.stagesCompleted)) {
    process.stderr.write('[summarizer] WARNING: stagesCompleted must be an array\n');
    s = { ...s, stagesCompleted: [] };
  }

  // ── Derive elapsedSeconds ────────────────────────────────────────────────
  const summary: RunSummary = {
    ...s,
    elapsedSeconds:
      s.elapsedSeconds > 0
        ? s.elapsedSeconds
        : Math.round((s.endTime.getTime() - s.startTime.getTime()) / 1000),
  };

  // ── Resolve options ───────────────────────────────────────────────────────
  const format = opts.format ?? resolveFormat();
  if (format === 'none') return;

  const tty = isTerminal();
  const color = opts.color ?? (format === 'pretty' && tty);
  const width = opts.width ?? process.stdout.columns ?? 80;

  const resolvedOpts: Required<EmitOptions> = { format, color, width };

  // ── Dispatch ──────────────────────────────────────────────────────────────
  if (format === 'pretty') {
    write(emitPretty(summary, resolvedOpts));
  } else {
    write(emitJson(summary));
  }
}

// ─── Summary builder ─────────────────────────────────────────────────────────

/**
 * Builds a `RunSummary` from run state, store events, and agent cost data.
 *
 * Extracts the summary-construction logic so the Worker only needs to call
 * `buildRunSummary` + `emitRunSummary`.
 */
export async function buildRunSummary(
  state: RunState,
  startTime: Date,
  store: RunStore,
  runner: AgentRunner,
  totalBudget?: number,
): Promise<RunSummary> {
  const endTime = new Date(state.updatedAt);
  let costUsed = 0;
  try {
    costUsed = await runner.getTotalCost();
  } catch {
    process.stderr.write('[summarizer] debug: cost estimator unavailable; reporting cost_used=0\n');
  }

  let stagesCompleted: string[];
  try {
    const events = await store.loadEvents(state.ticketId);
    const seen = new Set<string>();
    stagesCompleted = events
      .filter((e: RunEvent) => e.type === 'stage_entered')
      .map((e: RunEvent) => e.stage as string)
      .filter((s: string) => {
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
    if (stagesCompleted.length === 0) {
      stagesCompleted = [state.stage];
    }
  } catch {
    stagesCompleted = [state.stage];
  }

  return {
    ticketTitle: state.issueTitle ?? state.ticketId,
    stagesCompleted,
    startTime,
    endTime,
    elapsedSeconds: 0,
    costUsed,
    budget: totalBudget ?? null,
    finalStatus: state.stage,
  };
}
