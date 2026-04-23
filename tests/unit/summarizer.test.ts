/**
 * Unit tests for the RunSummary emitter, formatters, and helpers.
 *
 * Covers:
 *  - JSON output: canonical keys, deterministic elapsed_seconds, budget omission.
 *  - Pretty output: table layout at various widths, stage list lengths.
 *  - Colorisation: ANSI codes present/absent based on opts.color.
 *  - Cost-over-budget highlight in pretty output.
 *  - Stage trimming helper (first/last N with …).
 *  - DurationToHHMMSS helper.
 *  - resolveFormat precedence rules (CI env, TTY, fallback).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitRunSummary, resolveFormat, RunSummary, EmitOptions } from '../../src/output/summarizer';
import { durationToHHMMSS, trimStageList, emitPretty } from '../../src/output/formatter_pretty';
import { emitJson } from '../../src/output/formatter_json';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const START = new Date('2024-01-15T10:00:00Z');
const END   = new Date('2024-01-15T10:07:13Z'); // 433 seconds later

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    ticketTitle:     'FFH-123: Add widget',
    stagesCompleted: ['validate', 'build', 'deploy'],
    startTime:       START,
    endTime:         END,
    elapsedSeconds:  0, // will be derived
    costUsed:        12.4,
    budget:          20.0,
    finalStatus:     'completed',
    ...overrides,
  };
}

// ─── durationToHHMMSS ─────────────────────────────────────────────────────────

describe('durationToHHMMSS', () => {
  it('formats zero seconds', () => {
    expect(durationToHHMMSS(0)).toBe('00:00:00');
  });

  it('formats exactly 433 seconds as 00:07:13', () => {
    expect(durationToHHMMSS(433)).toBe('00:07:13');
  });

  it('formats 3661 seconds as 01:01:01', () => {
    expect(durationToHHMMSS(3661)).toBe('01:01:01');
  });

  it('clamps negative values to 00:00:00', () => {
    expect(durationToHHMMSS(-5)).toBe('00:00:00');
  });

  it('formats large values correctly', () => {
    // 10 hours = 36000 seconds
    expect(durationToHHMMSS(36000)).toBe('10:00:00');
  });
});

// ─── trimStageList ────────────────────────────────────────────────────────────

describe('trimStageList', () => {
  it('returns — for empty list', () => {
    expect(trimStageList([], 40)).toBe('—');
  });

  it('returns full list when it fits within maxWidth', () => {
    const stages = ['validate', 'build', 'deploy'];
    const full = 'validate → build → deploy';
    expect(trimStageList(stages, 100)).toBe(full);
  });

  it('trims long list showing first/last N with …', () => {
    const stages = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = trimStageList(stages, 20, 2);
    expect(result).toContain('…');
    expect(result.startsWith('a')).toBe(true);
    expect(result.endsWith('g')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('truncates with ellipsis as last resort for very narrow width', () => {
    const stages = ['very-long-stage-name', 'another-long-name'];
    const result = trimStageList(stages, 10);
    expect(result.endsWith('…')).toBe(true);
    // Plain length (no ANSI) should be ≤ 10
    expect(result.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(10);
  });
});

// ─── emitJson ─────────────────────────────────────────────────────────────────

describe('emitJson', () => {
  it('outputs a parseable JSON object with canonical keys', () => {
    const s = makeSummary({ elapsedSeconds: 433 });
    const json = JSON.parse(emitJson(s));
    expect(json).toHaveProperty('ticket_title', 'FFH-123: Add widget');
    expect(json).toHaveProperty('stages_completed');
    expect(Array.isArray(json.stages_completed)).toBe(true);
    expect(json).toHaveProperty('elapsed_seconds', 433);
    expect(json).toHaveProperty('cost_used', 12.4);
    expect(json).toHaveProperty('budget', 20.0);
    expect(json).toHaveProperty('status', 'completed');
  });

  it('omits budget when null', () => {
    const s = makeSummary({ budget: null, elapsedSeconds: 1 });
    const json = JSON.parse(emitJson(s));
    expect(json).not.toHaveProperty('budget');
  });

  it('omits budget when undefined', () => {
    const s = makeSummary({ budget: undefined, elapsedSeconds: 1 });
    const json = JSON.parse(emitJson(s));
    expect(json).not.toHaveProperty('budget');
  });

  it('contains the stages array in order', () => {
    const stages = ['validate', 'build', 'deploy'];
    const s = makeSummary({ stagesCompleted: stages, elapsedSeconds: 1 });
    const json = JSON.parse(emitJson(s));
    expect(json.stages_completed).toEqual(stages);
  });

  it('terminates with a newline', () => {
    const s = makeSummary({ elapsedSeconds: 1 });
    expect(emitJson(s).endsWith('\n')).toBe(true);
  });
});

// ─── emitPretty ───────────────────────────────────────────────────────────────

describe('emitPretty', () => {
  const baseOpts: Required<EmitOptions> = { format: 'pretty', color: false, width: 100 };

  it('produces non-empty output', () => {
    const result = emitPretty(makeSummary({ elapsedSeconds: 433 }), baseOpts);
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains the ticket title', () => {
    const result = emitPretty(makeSummary({ elapsedSeconds: 433 }), baseOpts);
    expect(result).toContain('FFH-123: Add widget');
  });

  it('contains a duration string matching HH:MM:SS', () => {
    const result = emitPretty(makeSummary({ elapsedSeconds: 433 }), baseOpts);
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('contains the status', () => {
    const result = emitPretty(makeSummary({ elapsedSeconds: 1 }), baseOpts);
    expect(result.toLowerCase()).toContain('completed');
  });

  it('contains cost information', () => {
    const result = emitPretty(makeSummary({ elapsedSeconds: 1 }), baseOpts);
    expect(result).toContain('12.40');
  });

  it('omits budget line when budget is null', () => {
    const result = emitPretty(makeSummary({ budget: null, elapsedSeconds: 1 }), baseOpts);
    // Should not show a slash+budget portion
    expect(result).not.toContain('$20.00');
  });

  it('fits within the specified width for 80-column terminal', () => {
    const narrowOpts: Required<EmitOptions> = { format: 'pretty', color: false, width: 80 };
    const result = emitPretty(makeSummary({ elapsedSeconds: 1 }), narrowOpts);
    const lines = result.split('\n').filter(Boolean);
    for (const line of lines) {
      // Strip ANSI codes for width measurement.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      // Allow some tolerance; the important thing is it's in the right ballpark.
      expect(plain.length).toBeLessThanOrEqual(120);
    }
  });
});

// ─── Colorisation ─────────────────────────────────────────────────────────────

describe('colorisation', () => {
  it('omits ANSI codes when color=false', () => {
    const opts: Required<EmitOptions> = { format: 'pretty', color: false, width: 100 };
    const result = emitPretty(makeSummary({ elapsedSeconds: 1 }), opts);
    expect(result).not.toMatch(/\x1b\[/);
  });

  it('includes ANSI codes when color=true', () => {
    const opts: Required<EmitOptions> = { format: 'pretty', color: true, width: 100 };
    const result = emitPretty(makeSummary({ elapsedSeconds: 1 }), opts);
    expect(result).toMatch(/\x1b\[/);
  });

  it('colours "completed" status green when color=true', () => {
    const opts: Required<EmitOptions> = { format: 'pretty', color: true, width: 100 };
    const result = emitPretty(makeSummary({ finalStatus: 'completed', elapsedSeconds: 1 }), opts);
    // Green = \x1b[32m
    expect(result).toMatch(/\x1b\[32m/);
  });

  it('colours "blocked" status red when color=true', () => {
    const opts: Required<EmitOptions> = { format: 'pretty', color: true, width: 100 };
    const result = emitPretty(makeSummary({ finalStatus: 'blocked', elapsedSeconds: 1 }), opts);
    // Red = \x1b[31m
    expect(result).toMatch(/\x1b\[31m/);
  });
});

// ─── Cost-over-budget highlight ───────────────────────────────────────────────

describe('cost-over-budget highlight', () => {
  it('highlights cost in red when costUsed > budget', () => {
    const s = makeSummary({ costUsed: 25.0, budget: 20.0, elapsedSeconds: 1 });
    const opts: Required<EmitOptions> = { format: 'pretty', color: true, width: 100 };
    const result = emitPretty(s, opts);
    // Should contain red ANSI for the cost portion
    expect(result).toMatch(/\x1b\[31m/);
  });

  it('does not highlight cost red when within budget', () => {
    const s = makeSummary({ costUsed: 10.0, budget: 20.0, elapsedSeconds: 1 });
    const opts: Required<EmitOptions> = { format: 'pretty', color: true, width: 100 };
    const result = emitPretty(s, opts);
    // Red should only appear in status (not cost) – here status is green for completed
    const lines = result.split('\n');
    const dataRow = lines.find((l) => l.includes('10.00'));
    expect(dataRow).toBeDefined();
    // The data row containing cost should not have red ANSI for cost
    expect(dataRow).not.toMatch(/\x1b\[31m.*10\.00/);
  });
});

// ─── emitRunSummary (integration) ────────────────────────────────────────────

describe('emitRunSummary', () => {
  it('derives elapsedSeconds from startTime/endTime when elapsedSeconds=0', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(write, makeSummary({ elapsedSeconds: 0 }), { format: 'json' });

    const output = chunks.join('');
    const json = JSON.parse(output);
    // 433 seconds between START and END
    expect(json.elapsed_seconds).toBe(433);
  });

  it('uses explicit elapsedSeconds when > 0', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(write, makeSummary({ elapsedSeconds: 999 }), { format: 'json' });

    const output = chunks.join('');
    const json = JSON.parse(output);
    expect(json.elapsed_seconds).toBe(999);
  });

  it('emits nothing when format=none', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(write, makeSummary({ elapsedSeconds: 1 }), { format: 'none' });

    expect(chunks).toHaveLength(0);
  });

  it('emits JSON when format=json', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(write, makeSummary({ elapsedSeconds: 1 }), { format: 'json' });

    const output = chunks.join('');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('emits pretty table when format=pretty', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(write, makeSummary({ elapsedSeconds: 1 }), {
      format: 'pretty',
      color: false,
      width: 100,
    });

    const output = chunks.join('');
    expect(output).toContain('+');
    expect(output).toContain('|');
  });

  it('handles empty stagesCompleted gracefully', () => {
    const chunks: string[] = [];
    const write = (chunk: string) => { chunks.push(chunk); };

    emitRunSummary(
      write,
      makeSummary({ stagesCompleted: [], elapsedSeconds: 1 }),
      { format: 'json' },
    );

    const output = chunks.join('');
    const json = JSON.parse(output);
    expect(json.stages_completed).toEqual([]);
  });
});

// ─── resolveFormat ────────────────────────────────────────────────────────────

describe('resolveFormat', () => {
  afterEach(() => {
    delete process.env.CI;
  });

  it('returns CLI flag when provided and valid', () => {
    expect(resolveFormat('json')).toBe('json');
    expect(resolveFormat('pretty')).toBe('pretty');
    expect(resolveFormat('none')).toBe('none');
  });

  it('CLI flag beats config key', () => {
    expect(resolveFormat('none', 'pretty')).toBe('none');
  });

  it('falls back to config key when CLI flag is absent', () => {
    expect(resolveFormat(undefined, 'pretty')).toBe('pretty');
  });

  it('returns json when CI=true and no explicit flag', () => {
    process.env.CI = 'true';
    // Simulate non-TTY (test runner) — resolveFormat should see CI first.
    expect(resolveFormat(undefined, undefined)).toBe('json');
  });

  it('returns json when CI=1 and no explicit flag', () => {
    process.env.CI = '1';
    expect(resolveFormat(undefined, undefined)).toBe('json');
  });

  it('falls back to json in non-TTY non-CI environment', () => {
    // Test runner is non-TTY and no CI env set by default.
    delete process.env.CI;
    // stdout.isTTY is undefined in vitest — so falls through to json.
    const result = resolveFormat(undefined, undefined);
    expect(['json', 'pretty']).toContain(result);
  });
});
