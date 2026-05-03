import assert from 'assert';
import { describe, it } from 'mocha';
import { getAgentSchema } from '../agent-schema-registry';
import { runSpecifyLiveFixture, runSpecifyLiveSuite } from '../eval/specify-live';
import { SPECIFY_SYSTEM_PROMPT } from '../phases/specify/prompt';

describe('specify live eval harness', () => {
  it('can run an optional judge pass with a bounded single revision and report both verdicts transparently', async () => {
    const fixture = {
      id: 'live-specify-judge',
      ticket: {
        title: 'Tighten dashboard loading-state expectations',
        description: 'The spec should define a checkable loading-state outcome.',
        labels: ['enhancement'],
      },
      priorDraft: [{ path: 'proposal.md', content: '# Draft proposal' }],
      operatorComments: ['Make the definition of done explicit.'],
    };
    const calls: string[] = [];

    const result = await runSpecifyLiveFixture(fixture as any, {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 1 },
      turnRunner: async (request) => {
        calls.push(request.prompt);
        if (calls.length === 1) {
          return {
            finalText: JSON.stringify({
              files: [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '- [ ] Improve loading feedback' },
              ],
              openQuestions: ['Should the acceptance criteria mention a measurable threshold?'],
              assumptions: [],
              risks: [],
            }),
            usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 },
            costMicroUsd: 700,
          };
        }
        if (calls.length === 2) {
          return {
            finalText: JSON.stringify({
              verdict: 'revise',
              summary: 'The proposal still leaves the success condition too vague.',
              issues: [{ code: 'definition-of-done', message: 'proposal.md should add a checkable acceptance criterion.' }],
            }),
            usage: { input_tokens: 15, cached_input_tokens: 0, output_tokens: 5 },
            costMicroUsd: 50,
          };
        }
        if (calls.length === 3) {
          assert.match(request.prompt, /definition-of-done/i);
          return {
            finalText: JSON.stringify({
              files: [
                { path: 'proposal.md', content: '# Proposal\n\nDefinition of done: loading feedback is visible within one second.' },
                { path: 'tasks.md', content: '- [ ] Add a measurable loading-state check' },
              ],
              openQuestions: [],
              assumptions: [],
              risks: [],
            }),
            usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 15 },
            costMicroUsd: 300,
          };
        }
        return {
          finalText: JSON.stringify({
            verdict: 'pass',
            summary: 'The revised proposal is reviewable as written.',
            issues: [],
          }),
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
          costMicroUsd: 25,
        };
      },
    });

    assert.strictEqual(result.status, 'refined');
    assert.strictEqual(result.totalTokens, 185);
    assert.strictEqual(result.costMicroUsd, 1000);
    assert.strictEqual((result as any).judge?.finalVerdict, 'pass');
    assert.strictEqual((result as any).judge?.revisionCount, 1);
    assert.deepStrictEqual((result as any).judge?.attempts.map((attempt: any) => ({
      attempt: attempt.attempt,
      verdict: attempt.verdict,
    })), [
      { attempt: 1, verdict: 'revise' },
      { attempt: 2, verdict: 'pass' },
    ]);
    assert.strictEqual((result as any).judge?.attempts[0]?.issues[0]?.code, 'definition-of-done');
    assert.strictEqual((result as any).judge?.attempts[0]?.costMicroUsd, 50);
    assert.strictEqual((result as any).judge?.attempts[1]?.costMicroUsd, 25);
  });

  it('caps direct judge revision requests at two revisions inside the harness', async () => {
    let callCount = 0;

    const result = await runSpecifyLiveFixture({
      id: 'live-specify-max-revisions',
      ticket: {
        title: 'Bound judge retries',
        description: 'Keep the live harness bounded even for direct callers.',
        labels: ['enhancement'],
      },
      priorDraft: [{ path: 'proposal.md', content: '# Proposal' }],
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
              summary: 'Still missing a measurable definition of done.',
              issues: [{ code: 'definition-of-done', message: 'Add a checkable success condition.' }],
            }),
          };
        }
        return {
          finalText: JSON.stringify({
            files: [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '- [ ] Add a measurable success condition' },
            ],
            openQuestions: ['What exact threshold should the definition of done use?'],
            assumptions: [],
            risks: [],
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
      provider: 'claude',
      model: 'claude-sonnet-4-6',
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
    assert.strictEqual(calls[0]?.provider, 'claude');
    assert.strictEqual(calls[0]?.model, 'claude-sonnet-4-6');
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

  it('forwards independent provider selections to generator and judge turns', async () => {
    const calls: Array<{ provider?: string; model?: string; prompt: string }> = [];

    const result = await runSpecifyLiveFixture({
      id: 'provider-routing',
      ticket: {
        title: 'Route provider selections independently',
        description: 'Use Claude for generation and Codex for the judge pass.',
        labels: ['enhancement'],
      },
      priorDraft: [{ path: 'proposal.md', content: '# Proposal' }],
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
              files: [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '- [ ] Keep provider routing explicit' },
              ],
              openQuestions: [],
              assumptions: [],
              risks: [],
            }),
          };
        }
        return {
          finalText: JSON.stringify({ verdict: 'pass', summary: 'Looks good.', issues: [] }),
        };
      },
    });

    assert.strictEqual(result.status, 'refined');
    assert.deepStrictEqual(calls.map((call) => ({ provider: call.provider, model: call.model })), [
      { provider: 'claude', model: 'claude-sonnet-4-6' },
      { provider: 'codex', model: 'gpt-5.3-codex' },
    ]);
  });

  it('surfaces generator outputs through the live recording callback', async () => {
    const seen: Array<{ id: string; finalText: string; usage?: unknown; costMicroUsd?: number }> = [];

    const result = await runSpecifyLiveFixture({
      id: 'record-callback',
      ticket: {
        title: 'Expose live generator output for recording',
        description: 'Recording should see the evaluated live result.',
        labels: ['enhancement'],
      },
      priorDraft: [{ path: 'proposal.md', content: '# Proposal' }],
      operatorComments: [],
    } as any, {
      worktreePath: '/tmp/eval-worktree',
      onGeneratorResult: (fixture, recording) => {
        seen.push({ id: fixture.id, ...recording });
      },
      turnRunner: async () => ({
        finalText: JSON.stringify({
          files: [
            { path: 'proposal.md', content: '# Recorded proposal' },
            { path: 'tasks.md', content: '- [ ] Confirm the rollout plan' },
          ],
          openQuestions: [],
          assumptions: [],
          risks: [],
        }),
        usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 4 },
        costMicroUsd: 123,
      }),
    });

    assert.strictEqual(result.status, 'refined');
    assert.deepStrictEqual(seen, [{
      id: 'record-callback',
      finalText: JSON.stringify({
        files: [
          { path: 'proposal.md', content: '# Recorded proposal' },
          { path: 'tasks.md', content: '- [ ] Confirm the rollout plan' },
        ],
        openQuestions: [],
        assumptions: [],
        risks: [],
      }),
      usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 4 },
      costMicroUsd: 123,
    }]);
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

  it('records judge parse failures as transparent judge errors without discarding the produced live result', async () => {
    const suite = await runSpecifyLiveSuite([
      {
        id: 'judge-parse-error',
        ticket: { title: 'Judge parse error', description: 'Keep the generated result, but surface the judge failure.', labels: [] },
        priorDraft: [{ path: 'proposal.md', content: '# Proposal' }],
        operatorComments: [],
      } as any,
    ], {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 0 },
      turnRunner: async (_request) => {
        if (!_request.prompt.includes('Candidate response JSON')) {
          return {
            finalText: JSON.stringify({
              files: [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '- [ ] Keep judge failures transparent' },
              ],
              openQuestions: [],
              assumptions: [],
              risks: [],
            }),
          };
        }
        return {
          finalText: 'not-json',
        };
      },
    });

    assert.strictEqual(suite.results[0]?.status, 'refined');
    assert.strictEqual((suite.results[0] as any)?.judge?.finalVerdict, 'error');
    assert.match((suite.results[0] as any)?.judge?.attempts[0]?.errorMessage ?? '', /valid JSON/i);
    assert.deepStrictEqual((suite as any).judgeSummary?.byVerdict, { pass: 0, revise: 0, error: 1 });
  });
});