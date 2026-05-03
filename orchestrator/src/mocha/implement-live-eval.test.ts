import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import { runImplementLiveFixture, runImplementLiveSuite } from '../eval/implement-live';
import { IMPLEMENT_SYSTEM_PROMPT } from '../phases/implement/prompt';

describe('implement live eval harness', () => {
  it('can run an optional judge pass with no revision and surface a revise verdict transparently', async () => {
    const fixture = {
      id: 'live-implement-judge',
      ticket: {
        title: 'Add guardrails to eval output rendering',
        description: 'Keep implementation scoped to the requested guardrails.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Update render path only' },
      ],
      operatorComments: ['Do not pull in unrelated refactors.'],
    };

    let callCount = 0;
    const result = await runImplementLiveFixture(fixture as any, {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 0 },
      turnRunner: async (request) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            finalText: JSON.stringify({
              filesWritten: [{ path: 'src/cli/eval.ts', content: 'export const guardrails = true;\n' }],
              commitMessage: 'feat(cli): add guardrails',
              summary: 'Adds the requested guardrails.',
              followUps: [],
            }),
            usage: { input_tokens: 90, cached_input_tokens: 15, output_tokens: 20 },
            costMicroUsd: 500,
          };
        }
        assert.match(request.prompt, /Candidate response JSON/);
        return {
          finalText: JSON.stringify({
            verdict: 'revise',
            summary: 'The response does not explain how the acceptance criteria map to the changed file.',
            issues: [{ code: 'dod-mapping', message: 'summary should map the requested guardrail to the concrete change.' }],
          }),
          usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4 },
          costMicroUsd: 35,
        };
      },
    });

    assert.strictEqual(result.status, 'produced');
    assert.strictEqual(result.totalTokens, 110);
    assert.strictEqual(result.costMicroUsd, 500);
    assert.strictEqual((result as any).judge?.finalVerdict, 'revise');
    assert.strictEqual((result as any).judge?.revisionCount, 0);
    assert.strictEqual((result as any).judge?.attempts[0]?.issues[0]?.code, 'dod-mapping');
    assert.strictEqual((result as any).judge?.attempts[0]?.costMicroUsd, 35);
  });

  it('caps direct judge revision requests at two revisions inside the harness', async () => {
    let callCount = 0;

    const result = await runImplementLiveFixture({
      id: 'live-implement-max-revisions',
      ticket: {
        title: 'Bound implement judge retries',
        description: 'Keep live implement eval bounded for direct callers.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Keep judge retries bounded' },
      ],
      operatorComments: [],
    } as any, {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 99 },
      turnRunner: async (request) => {
        callCount += 1;
        if (request.prompt.includes('Candidate response JSON')) {
          return {
            finalText: JSON.stringify({
              verdict: 'revise',
              summary: 'The summary still does not map the change back to the acceptance criteria.',
              issues: [{ code: 'dod-mapping', message: 'Explain how the written file satisfies the requested guardrail.' }],
            }),
          };
        }
        return {
          finalText: JSON.stringify({
            filesWritten: [{ path: 'src/eval.ts', content: 'export const bounded = true;\n' }],
            commitMessage: 'feat: bound judge retries',
            summary: 'Keeps direct live-eval judge retries bounded.',
            followUps: [],
          }),
        };
      },
    });

    assert.strictEqual(callCount, 6);
    assert.strictEqual((result as any).judge?.maxRevisions, 2);
    assert.strictEqual((result as any).judge?.revisionCount, 2);
    assert.deepStrictEqual((result as any).judge?.attempts.map((attempt: any) => attempt.verdict), ['revise', 'revise', 'revise']);
  });

  it('reuses current prompt/schema wiring and preserves the replay result model', async () => {
    const calls: Array<{ worktreePath: string; prompt: string; systemPrompt?: string; outputSchema?: unknown; provider?: string; model?: string }> = [];
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
      provider: 'claude',
      model: 'claude-sonnet-4-6',
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
    assert.strictEqual(calls[0]?.provider, 'claude');
    assert.strictEqual(calls[0]?.model, 'claude-sonnet-4-6');
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

  it('forwards independent provider selections to generator and judge turns', async () => {
    const calls: Array<{ provider?: string; model?: string; prompt: string }> = [];

    const result = await runImplementLiveFixture({
      id: 'provider-routing',
      ticket: {
        title: 'Route provider selections independently',
        description: 'Use Claude for generation and Codex for the judge pass.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Keep provider routing explicit' },
      ],
      operatorComments: [],
    } as any, {
      worktreePath: '/tmp/eval-worktree',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      judge: { maxRevisions: 0, provider: 'codex', model: 'gpt-5.3-codex' },
      turnRunner: async (request) => {
        calls.push(request);
        if (!request.prompt.includes('Candidate response JSON')) {
          return {
            finalText: JSON.stringify({
              filesWritten: [{ path: 'src/eval.ts', content: 'export const routed = true;\n' }],
              commitMessage: 'feat: keep provider routing explicit',
              summary: 'Keeps provider routing explicit between generator and judge.',
              followUps: [],
            }),
          };
        }
        return {
          finalText: JSON.stringify({ verdict: 'pass', summary: 'Looks good.', issues: [] }),
        };
      },
    });

    assert.strictEqual(result.status, 'produced');
    assert.deepStrictEqual(calls.map((call) => ({ provider: call.provider, model: call.model })), [
      { provider: 'claude', model: 'claude-sonnet-4-6' },
      { provider: 'codex', model: 'gpt-5.3-codex' },
    ]);
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

  it('records judge runner failures as transparent judge errors in suite-level telemetry', async () => {
    const suite = await runImplementLiveSuite([
      {
        id: 'implement-judge-runtime-error',
        ticket: { title: 'Judge runtime error', description: 'Keep the implementation result but surface judge failure.', labels: [] },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Preserve generator result' },
        ],
        operatorComments: [],
      } as any,
    ], {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 0 },
      turnRunner: async (request) => {
        if (!request.prompt.includes('Candidate response JSON')) {
          return {
            finalText: JSON.stringify({
              filesWritten: [{ path: 'src/eval.ts', content: 'export const ok = true;\n' }],
              commitMessage: 'feat: keep generator result',
              summary: 'Keeps the generated implementation result.',
              followUps: [],
            }),
          };
        }
        throw new Error('judge transport failed');
      },
    });

    assert.strictEqual(suite.results[0]?.status, 'produced');
    assert.strictEqual((suite.results[0] as any)?.judge?.finalVerdict, 'error');
    assert.match((suite.results[0] as any)?.judge?.attempts[0]?.errorMessage ?? '', /judge transport failed/i);
    assert.deepStrictEqual((suite as any).judgeSummary?.byVerdict, { pass: 0, revise: 0, error: 1 });
  });
});