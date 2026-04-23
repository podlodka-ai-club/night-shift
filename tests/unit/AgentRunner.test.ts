import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRunner } from '../../src/providers/AgentRunner';
import { RunStore } from '../../src/store/RunStore';
import { RunState } from '../../src/types';
import type { Config } from '../../src/config';

function makeConfig(budgetOverride: Partial<Config['budgets']> = {}): Config {
  return {
    github: {
      token: 'tok', projectOwner: 'o', projectOwnerType: 'user',
      projectNumber: 1, repoOwner: 'o', repoName: 'r',
      defaultBranch: 'main', statusFieldName: 'Status',
      statusValues: { ready: 'Ready', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked' },
    },
    anthropic: { apiKey: 'key', model: 'claude-sonnet-4-6' },
    codex: { enabled: true, apiKey: 'codex-key', model: 'gpt-5-mini' },
    agents: {
      planner: { provider: 'codex', model: 'gpt-5-mini' },
      implementer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      reviewer: { provider: 'codex', model: 'gpt-5-mini' },
    },
    budgets: { specify: 0.5, implement: 2.0, review: 0.5, totalPerTicket: 5.0, ...budgetOverride },
    pricing: {
      codex: { inputPer1kTokens: 0.00075, outputPer1kTokens: 0.0045 },
      anthropic: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      sonnet: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      modelOverrides: {},
    },
    dataDir: '/tmp',
    repoDir: '/tmp/repo',
  } as Config;
}

describe('AgentRunner.estimateCost', () => {
  it('calculates codex cost correctly', () => {
    const runner = new AgentRunner(makeConfig(), {} as RunStore, 'test');
    // 1000 input * 0.00075/1k + 500 output * 0.0045/1k
    expect(runner.estimateCost('codex', 'gpt-5-mini', 1000, 500)).toBeCloseTo(0.003, 6);
  });

  it('calculates claude cost correctly', () => {
    const runner = new AgentRunner(makeConfig(), {} as RunStore, 'test');
    // 2000 * 0.003/1000 + 1000 * 0.015/1000
    expect(runner.estimateCost('anthropic', 'claude-sonnet-4-6', 2000, 1000)).toBeCloseTo(0.021, 6);
  });

  it('uses model overrides when present', () => {
    const config = makeConfig();
    config.pricing.modelOverrides['anthropic:claude-opus-4-1'] = {
      inputPer1kTokens: 0.01,
      outputPer1kTokens: 0.02,
    };

    const runner = new AgentRunner(config, {} as RunStore, 'test');

    expect(runner.estimateCost('anthropic', 'claude-opus-4-1', 1000, 500)).toBeCloseTo(0.02, 6);
  });
});

describe('AgentRunner budget enforcement', () => {
  let tmpDir: string;
  let store: RunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-agent-test-'));
    store = new RunStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  async function makeRunner(budgetOverride: Partial<Config['budgets']> = {}): Promise<{ runner: AgentRunner }> {
    const state: RunState = {
      ticketId: 'ticket-test', repoOwner: 'o', repoName: 'r',
      branch: 'feature', stage: 'claimed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await store.create(state);
    const runner = new AgentRunner(makeConfig(budgetOverride), store, 'ticket-test');
    return { runner };
  }

  it('allows invocation when budget is not exceeded', async () => {
    const { runner } = await makeRunner();
    await expect(runner.checkBudget('specify', 0.1)).resolves.toBeUndefined();
  });

  it('throws BudgetExceededError when total ticket budget is exceeded', async () => {
    const { runner } = await makeRunner({ totalPerTicket: 0.001 });
    // Record usage that pushes total over the limit
    await store.appendUsage('ticket-test', {
      step: 'specify', role: 'implementer', provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.002,
      elapsedMs: 1000, ts: new Date().toISOString(),
    });
    await expect(runner.checkBudget('implement', 0.0)).rejects.toThrow('Budget exceeded');
  });

  it('throws BudgetExceededError when stage budget is exceeded by recorded usage', async () => {
    const { runner } = await makeRunner({ review: 0.001 });
    await store.appendUsage('ticket-test', {
      step: 'review-findings', role: 'reviewer', budgetStage: 'review', provider: 'codex', model: 'gpt-5-mini',
      inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.002,
      elapsedMs: 1000, ts: new Date().toISOString(),
    });
    await expect(runner.checkBudget('review')).rejects.toThrow('Budget exceeded');
  });
});
