import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import { runImplementLiveFixture, runImplementLiveSuite } from '../eval/implement-live';
import { IMPLEMENT_SYSTEM_PROMPT } from '../phases/implement/prompt';

describe('implement live eval harness', () => {
  it('reuses current prompt/schema wiring and preserves the replay result model', async () => {
    const calls: Array<{ worktreePath: string; prompt: string; systemPrompt?: string; outputSchema?: unknown }> = [];
    const fixture = {
      id: 'live-implement',
      ticket: {
        title: 'Add a strict mode flag to eval output',
        description: 'Implement a stricter CLI flag and tests.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Add CLI flag\n- [ ] Add tests' },
      ],
      operatorComments: ['Keep the flag backward compatible.'],
      expected: { status: 'produced', minFilesWritten: 1 },
    };

    const result = await runImplementLiveFixture(fixture as any, {
      worktreePath: '/tmp/eval-worktree',
      turnRunner: async (request) => {
        calls.push(request);
        return {
          finalText: JSON.stringify({
            filesWritten: [{ path: 'src/cli/eval.ts', content: 'export const strict = true;\n' }],
            commitMessage: 'feat(cli): add strict mode',
            summary: 'Adds a strict evaluation flag.',
            followUps: ['Confirm help text wording with operators.'],
          }),
          usage: { input_tokens: 210, cached_input_tokens: 60, output_tokens: 55 },
          costMicroUsd: 991,
        };
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.worktreePath, '/tmp/eval-worktree');
    assert.strictEqual(calls[0]?.systemPrompt, IMPLEMENT_SYSTEM_PROMPT);
    assert.deepStrictEqual(calls[0]?.outputSchema, getAgentSchema('implement-response-v1').jsonSchema);
    assert.match(calls[0]?.prompt ?? '', /Add a strict mode flag to eval output/);
    assert.match(calls[0]?.prompt ?? '', /Keep the flag backward compatible/);
    assert.match(calls[0]?.prompt ?? '', /proposal\.md/);
    assert.strictEqual(result.status, 'produced');
    assert.strictEqual(result.filesWrittenCount, 1);
    assert.strictEqual(result.totalContentChars, 'export const strict = true;\n'.length);
    assert.strictEqual(result.commitMessageLength, 'feat(cli): add strict mode'.length);
    assert.strictEqual(result.summaryLength, 'Adds a strict evaluation flag.'.length);
    assert.strictEqual(result.followUpsCount, 1);
    assert.strictEqual(result.totalTokens, 265);
    assert.strictEqual(result.costMicroUsd, 991);
    assert.strictEqual(result.expectationMismatch, undefined);
  });

  it('captures live runner failures as parse errors so the suite remains comparable', async () => {
    const suite = await runImplementLiveSuite([
      {
        id: 'live-runtime-error',
        ticket: { title: 'Broken runtime', description: 'Trigger the runner failure.', labels: [] },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Re-run after runtime repair' },
        ],
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

  it('reports missing live fixture inputs as parse errors without calling the runner', async () => {
    let calls = 0;
    const suite = await runImplementLiveSuite([
      {
        id: 'missing-ticket',
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Fill in the missing ticket' },
        ],
        operatorComments: [],
      } as any,
    ], {
      worktreePath: '/tmp/eval-worktree',
      turnRunner: async () => {
        calls += 1;
        return {
          finalText: JSON.stringify({ filesWritten: [], commitMessage: 'x', summary: 'x', followUps: [] }),
        };
      },
    });

    assert.strictEqual(calls, 0);
    assert.strictEqual(suite.results[0]?.status, 'parse_error');
    assert.match(suite.results[0]?.errorMessage ?? '', /requires fixture\.ticket/i);
  });
});