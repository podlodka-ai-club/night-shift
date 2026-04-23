/**
 * Integration tests for the RunSummary emission.
 *
 * These tests exercise `emitRunSummary` through the public API and verify:
 *   - Summary appears exactly once on the provided writer.
 *   - JSON format produces a valid, machine-parseable object with expected keys.
 *   - CI=true env resolves default format to "json".
 *   - Pretty format produces a readable table with expected structure.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { emitRunSummary, resolveFormat, RunSummary } from '../../src/output/summarizer';

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const start = new Date('2024-03-01T09:00:00Z');
  const end   = new Date('2024-03-01T09:10:00Z'); // 600 s
  return {
    ticketTitle:     'FFH-42: Implement summary feature',
    stagesCompleted: ['claimed', 'specified', 'implemented', 'validated', 'pr_opened', 'completed'],
    startTime:       start,
    endTime:         end,
    elapsedSeconds:  0,
    costUsed:        1.23,
    budget:          5.0,
    finalStatus:     'completed',
    ...overrides,
  };
}

// ─── Single-emission guarantee (unit simulation) ──────────────────────────────

describe('single-emission guarantee', () => {
  it('emits exactly one chunk per call in json format', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), { format: 'json' });
    // emitRunSummary writes one block per call; count must be exactly 1.
    expect(chunks).toHaveLength(1);
  });

  it('emits exactly one chunk per call in pretty format', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), {
      format: 'pretty',
      color: false,
      width: 100,
    });
    expect(chunks).toHaveLength(1);
  });
});

// ─── JSON format ──────────────────────────────────────────────────────────────

describe('JSON summary format', () => {
  it('produces valid JSON', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), { format: 'json' });
    expect(() => JSON.parse(chunks.join(''))).not.toThrow();
  });

  it('contains all canonical keys', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), { format: 'json' });
    const obj = JSON.parse(chunks.join(''));

    expect(obj).toHaveProperty('ticket_title');
    expect(obj).toHaveProperty('stages_completed');
    expect(obj).toHaveProperty('elapsed_seconds');
    expect(obj).toHaveProperty('cost_used');
    expect(obj).toHaveProperty('budget');
    expect(obj).toHaveProperty('status');
  });

  it('ticket_title matches input', () => {
    const chunks: string[] = [];
    emitRunSummary(
      (c) => chunks.push(c),
      makeSummary({ ticketTitle: 'FFH-99: My test ticket' }),
      { format: 'json' },
    );
    const obj = JSON.parse(chunks.join(''));
    expect(obj.ticket_title).toBe('FFH-99: My test ticket');
  });

  it('elapsed_seconds is deterministically derived from startTime/endTime', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary({ elapsedSeconds: 0 }), { format: 'json' });
    const obj = JSON.parse(chunks.join(''));
    // 600 seconds between 09:00 and 09:10
    expect(obj.elapsed_seconds).toBe(600);
  });

  it('stages_completed is an array in correct order', () => {
    const stages = ['claimed', 'specified', 'implemented', 'completed'];
    const chunks: string[] = [];
    emitRunSummary(
      (c) => chunks.push(c),
      makeSummary({ stagesCompleted: stages }),
      { format: 'json' },
    );
    const obj = JSON.parse(chunks.join(''));
    expect(obj.stages_completed).toEqual(stages);
  });

  it('budget is omitted when null', () => {
    const chunks: string[] = [];
    emitRunSummary(
      (c) => chunks.push(c),
      makeSummary({ budget: null }),
      { format: 'json' },
    );
    const obj = JSON.parse(chunks.join(''));
    expect(obj).not.toHaveProperty('budget');
  });

  it('status field reflects finalStatus', () => {
    const chunks: string[] = [];
    emitRunSummary(
      (c) => chunks.push(c),
      makeSummary({ finalStatus: 'blocked' }),
      { format: 'json' },
    );
    const obj = JSON.parse(chunks.join(''));
    expect(obj.status).toBe('blocked');
  });
});

// ─── Pretty format ────────────────────────────────────────────────────────────

describe('pretty summary format', () => {
  it('produces a table with border characters', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), {
      format: 'pretty',
      color: false,
      width: 120,
    });
    const out = chunks.join('');
    expect(out).toContain('+');
    expect(out).toContain('|');
    expect(out).toContain('-');
  });

  it('includes ticket title in table', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), {
      format: 'pretty',
      color: false,
      width: 120,
    });
    const out = chunks.join('');
    expect(out).toContain('FFH-42: Implement summary feature');
  });

  it('includes duration in HH:MM:SS format', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), {
      format: 'pretty',
      color: false,
      width: 120,
    });
    const out = chunks.join('');
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('includes status in table', () => {
    const chunks: string[] = [];
    emitRunSummary((c) => chunks.push(c), makeSummary(), {
      format: 'pretty',
      color: false,
      width: 120,
    });
    const out = chunks.join('');
    expect(out.toLowerCase()).toContain('completed');
  });
});

// ─── CI env default format ────────────────────────────────────────────────────

describe('CI env default format resolution', () => {
  afterEach(() => {
    delete process.env.CI;
  });

  it('resolves to json when CI=true', () => {
    process.env.CI = 'true';
    expect(resolveFormat(undefined, undefined)).toBe('json');
  });

  it('resolves to json when CI=1', () => {
    process.env.CI = '1';
    expect(resolveFormat(undefined, undefined)).toBe('json');
  });

  it('CLI flag beats CI env', () => {
    process.env.CI = 'true';
    expect(resolveFormat('pretty', undefined)).toBe('pretty');
  });

  it('config key beats CI env', () => {
    process.env.CI = 'true';
    expect(resolveFormat(undefined, 'none')).toBe('none');
  });
});
