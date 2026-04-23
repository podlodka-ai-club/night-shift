import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunStore } from '../../src/store/RunStore';
import { RunState } from '../../src/types';

function makeState(ticketId: string): RunState {
  return {
    ticketId,
    repoOwner: 'owner',
    repoName: 'repo',
    branch: `feature-factory/${ticketId}`,
    stage: 'claimed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('RunStore', () => {
  let tmpDir: string;
  let store: RunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
    store = new RunStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates and loads run state', async () => {
    const state = makeState('ticket-1');
    await store.create(state);
    const loaded = await store.load('ticket-1');
    expect(loaded.ticketId).toBe('ticket-1');
    expect(loaded.stage).toBe('claimed');
  });

  it('does not overwrite an existing run on create', async () => {
    const state = makeState('ticket-1b');
    await store.create(state);
    await expect(store.create(state)).rejects.toThrow();
  });

  it('updates a field in run state', async () => {
    await store.create(makeState('ticket-2'));
    await store.update('ticket-2', { stage: 'specified' });
    const loaded = await store.load('ticket-2');
    expect(loaded.stage).toBe('specified');
  });

  it('preserves other fields on partial update', async () => {
    const state = makeState('ticket-3');
    await store.create({ ...state, issueTitle: 'My issue' });
    await store.update('ticket-3', { stage: 'implemented' });
    const loaded = await store.load('ticket-3');
    expect(loaded.issueTitle).toBe('My issue');
  });

  it('lists active runs and excludes completed/blocked', async () => {
    await store.create(makeState('ticket-4'));
    await store.create(makeState('ticket-5'));
    await store.update('ticket-5', { stage: 'completed' });
    await store.create(makeState('ticket-6'));
    await store.update('ticket-6', { stage: 'blocked' });

    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].ticketId).toBe('ticket-4');
  });

  it('resumes from the last durable stage', async () => {
    await store.create(makeState('ticket-7'));
    await store.update('ticket-7', { stage: 'implemented' });
    const active = await store.listActive();
    expect(active[0].stage).toBe('implemented');
  });

  it('locks and unlocks correctly', async () => {
    await store.create(makeState('ticket-8'));
    expect(await store.isLocked('ticket-8')).toBe(false);
    await store.lock('ticket-8');
    expect(await store.isLocked('ticket-8')).toBe(true);
    await store.unlock('ticket-8');
    expect(await store.isLocked('ticket-8')).toBe(false);
  });

  it('rejects taking an already-held lock', async () => {
    await store.create(makeState('ticket-8b'));
    await store.lock('ticket-8b');
    await expect(store.lock('ticket-8b')).rejects.toThrow('already locked');
  });

  it('appends events to jsonl', async () => {
    await store.create(makeState('ticket-9'));
    await store.appendEvent('ticket-9', {
      ts: new Date().toISOString(),
      stage: 'claimed',
      type: 'stage_entered',
      message: 'hello',
    });
    const content = fs.readFileSync(path.join(store.runDir('ticket-9'), 'events.jsonl'), 'utf-8');
    expect(content).toContain('"stage_entered"');
    expect(content).toContain('hello');
  });

  it('accumulates usage records', async () => {
    await store.create(makeState('ticket-10'));
    await store.appendUsage('ticket-10', {
      step: 'specify', provider: 'anthropic', model: 'claude-opus-4-5',
      inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.005,
      elapsedMs: 1000, ts: new Date().toISOString(),
    });
    await store.appendUsage('ticket-10', {
      step: 'implement', provider: 'anthropic', model: 'claude-sonnet-4-5',
      inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.002,
      elapsedMs: 2000, ts: new Date().toISOString(),
    });
    const usage = await store.loadUsage('ticket-10');
    expect(usage).toHaveLength(2);
    expect(usage[1].step).toBe('implement');
  });
});
