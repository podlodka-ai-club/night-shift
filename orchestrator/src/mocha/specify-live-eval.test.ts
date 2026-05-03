import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import { runSpecifyLiveFixture, runSpecifyLiveSuite } from '../eval/specify-live';
import { SPECIFY_SYSTEM_PROMPT } from '../phases/specify/prompt';

describe('specify live eval harness', () => {
  it('reuses current prompt/schema wiring and preserves the replay result model', async () => {
    const calls: Array<{ worktreePath: string; prompt: string; systemPrompt?: string; outputSchema?: unknown }> = [];
    const fixture = {
      id: 'live-specify',
      ticket: {
        title: 'Improve the operator dashboard load flow',
        description: 'The dashboard feels slow and needs a clearer loading state.',
        labels: ['enhancement'],
      },
      priorDraft: [{ path: 'proposal.md', content: '# Draft proposal' }],
      operatorComments: ['Please call out any rollout risk.'],
      expected: { status: 'needs_input', minOpenQuestions: 1 },
    };

    const result = await runSpecifyLiveFixture(fixture as any, {
      worktreePath: '/tmp/eval-worktree',
      turnRunner: async (request) => {
        calls.push(request);
        return {
          finalText: JSON.stringify({
            files: [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '- [ ] Confirm success metric' },
            ],
            openQuestions: ['What latency target counts as fixed?'],
            assumptions: ['Existing dashboard metrics are trustworthy.'],
            risks: ['The loading state may hide a slower backend.'],
          }),
          usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 35 },
          costMicroUsd: 777,
        };
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.worktreePath, '/tmp/eval-worktree');
    assert.strictEqual(calls[0]?.systemPrompt, SPECIFY_SYSTEM_PROMPT);
    assert.deepStrictEqual(calls[0]?.outputSchema, getAgentSchema('specify-response-v1').jsonSchema);
    assert.match(calls[0]?.prompt ?? '', /Improve the operator dashboard load flow/);
    assert.match(calls[0]?.prompt ?? '', /Please call out any rollout risk/);
    assert.match(calls[0]?.prompt ?? '', /proposal\.md/);
    assert.strictEqual(result.status, 'needs_input');
    assert.strictEqual(result.openQuestionsCount, 1);
    assert.strictEqual(result.assumptionsCount, 1);
    assert.strictEqual(result.risksCount, 1);
    assert.strictEqual(result.filesCount, 2);
    assert.strictEqual(result.totalTokens, 155);
    assert.strictEqual(result.costMicroUsd, 777);
    assert.strictEqual(result.expectationMismatch, undefined);
  });

  it('reports missing live fixture inputs as parse errors without calling the runner', async () => {
    let calls = 0;
    const suite = await runSpecifyLiveSuite([
      {
        id: 'missing-ticket',
        priorDraft: [],
        operatorComments: [],
        expected: { status: 'refined' },
      } as any,
    ], {
      worktreePath: '/tmp/eval-worktree',
      turnRunner: async () => {
        calls += 1;
        return {
          finalText: JSON.stringify({ files: [], openQuestions: [], assumptions: [], risks: [] }),
        };
      },
    });

    assert.strictEqual(calls, 0);
    assert.strictEqual(suite.results[0]?.status, 'parse_error');
    assert.match(suite.results[0]?.errorMessage ?? '', /requires fixture\.ticket/i);
    assert.strictEqual(suite.summary.byStatus.parse_error, 1);
  });

  it('captures live runner failures as parse errors so the suite remains comparable', async () => {
    const suite = await runSpecifyLiveSuite([
      {
        id: 'live-runtime-error',
        ticket: { title: 'Broken runtime', description: 'Trigger the runner failure.', labels: [] },
        priorDraft: [{ path: 'proposal.md', content: '# Proposal' }],
        operatorComments: [],
      } as any,
    ], {
      worktreePath: '/tmp/eval-worktree',
      turnRunner: async () => {
        throw new Error('codex transport failed');
      },
    });

    assert.strictEqual(suite.results[0]?.status, 'parse_error');
    assert.match(suite.results[0]?.errorMessage ?? '', /codex transport failed/i);
    assert.strictEqual(suite.summary.byStatus.parse_error, 1);
  });
});