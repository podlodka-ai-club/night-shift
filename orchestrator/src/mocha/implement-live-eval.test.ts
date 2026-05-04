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

  it('uses the donor-faithful R1-R6 judge rubric for implement reviews', async () => {
    let judgeSystemPrompt = '';

    const result = await runImplementLiveFixture({
      id: 'live-implement-judge-rubric',
      ticket: {
        title: 'Keep implement judge scoring donor-faithful',
        description: 'The implement judge prompt should keep the donor rubric language.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal\n\n## Acceptance criteria\n- Map changed files back to the requested guardrail.' },
        { path: 'tasks.md', content: '- [ ] Update src/cli/eval.ts\n- [ ] Add tests\n- [ ] Maybe restructure the CLI bootstrap' },
      ],
      operatorComments: [],
    } as any, {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 0 },
      turnRunner: async (request) => {
        if (request.prompt.includes('Candidate response JSON')) {
          judgeSystemPrompt = request.systemPrompt ?? '';
          return {
            finalText: JSON.stringify({ verdict: 'pass', summary: 'Looks good.', issues: [] }),
          };
        }

        return {
          finalText: JSON.stringify({
            filesWritten: [{ path: 'src/cli/eval.ts', content: 'export const guardrails = true;\n' }],
            commitMessage: 'feat(cli): keep guardrails explicit',
            summary: 'Updates src/cli/eval.ts and adds a matching test name for the requested guardrail.',
            followUps: [],
          }),
        };
      },
    });

    assert.strictEqual(result.status, 'produced');
    assert.match(judgeSystemPrompt, /R1\. FAITHFULNESS/i);
    assert.match(judgeSystemPrompt, /R2\. DOD MAPPING/i);
    assert.match(judgeSystemPrompt, /R3\. SCOPE/i);
    assert.match(judgeSystemPrompt, /R4\. EVIDENCE/i);
    assert.match(judgeSystemPrompt, /R5\. ASSUMPTIONS/i);
    assert.match(judgeSystemPrompt, /R6\. SELF-ATTACK/i);
    assert.match(judgeSystemPrompt, /Do not require execution evidence/i);
  });

  it('can run an optional judge pass with a bounded single revision and report both verdicts transparently', async () => {
    const fixture = {
      id: 'live-implement-judge-pass-after-revision',
      ticket: {
        title: 'Clarify implementation acceptance mapping',
        description: 'The implementation response should clearly map files back to requested guardrails.',
        labels: ['feature'],
      },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Map changed files back to acceptance criteria' },
      ],
      operatorComments: ['Explain how the changed file satisfies the requested guardrail.'],
    };
    const calls: string[] = [];

    const result = await runImplementLiveFixture(fixture as any, {
      worktreePath: '/tmp/eval-worktree',
      judge: { maxRevisions: 1 },
      turnRunner: async (request) => {
        calls.push(request.prompt);
        if (calls.length === 1) {
          return {
            finalText: JSON.stringify({
              filesWritten: [{ path: 'src/cli/eval.ts', content: 'export const guardrails = true;\n' }],
              commitMessage: 'feat(cli): tighten guardrails',
              summary: 'Adds the requested guardrails.',
              followUps: [],
            }),
            usage: { input_tokens: 90, cached_input_tokens: 15, output_tokens: 20 },
            costMicroUsd: 500,
          };
        }
        if (calls.length === 2) {
          return {
            finalText: JSON.stringify({
              verdict: 'revise',
              summary: 'The response still needs to map the changed file back to the acceptance criteria.',
              issues: [{ code: 'dod-mapping', message: 'summary should explain how src/cli/eval.ts satisfies the requested guardrail.' }],
            }),
            usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4 },
            costMicroUsd: 35,
          };
        }
        if (calls.length === 3) {
          assert.match(request.prompt, /dod-mapping/i);
          return {
            finalText: JSON.stringify({
              filesWritten: [{ path: 'src/cli/eval.ts', content: 'export const guardrails = true;\n' }],
              commitMessage: 'feat(cli): tighten guardrails',
              summary: 'Updates src/cli/eval.ts so the requested guardrail is enforced directly in the CLI path.',
              followUps: [],
            }),
            usage: { input_tokens: 35, cached_input_tokens: 10, output_tokens: 10 },
            costMicroUsd: 250,
          };
        }
        return {
          finalText: JSON.stringify({
            verdict: 'pass',
            summary: 'The revised implementation is reviewable as written.',
            issues: [],
          }),
          usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 3 },
          costMicroUsd: 20,
        };
      },
    });

    assert.strictEqual(result.status, 'produced');
    assert.strictEqual(result.totalTokens, 155);
    assert.strictEqual(result.costMicroUsd, 750);
    assert.strictEqual((result as any).judge?.finalVerdict, 'pass');
    assert.strictEqual((result as any).judge?.revisionCount, 1);
    assert.deepStrictEqual((result as any).judge?.attempts.map((attempt: any) => ({
      attempt: attempt.attempt,
      verdict: attempt.verdict,
    })), [
      { attempt: 1, verdict: 'revise' },
      { attempt: 2, verdict: 'pass' },
    ]);
    assert.strictEqual((result as any).judge?.attempts[0]?.issues[0]?.code, 'dod-mapping');
    assert.strictEqual((result as any).judge?.attempts[0]?.costMicroUsd, 35);
    assert.strictEqual((result as any).judge?.attempts[1]?.costMicroUsd, 20);
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
    const calls: Array<{ worktreePath: string; prompt: string; systemPrompt?: string; outputSchema?: unknown; provider?: string; config?: { model?: string } }> = [];
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
      config: { model: 'claude-sonnet-4-6' },
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
    assert.strictEqual(calls[0]?.config?.model, 'claude-sonnet-4-6');
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
    const calls: Array<{ provider?: string; config?: { model?: string }; prompt: string }> = [];

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
      config: { model: 'claude-sonnet-4-6' },
      judge: { maxRevisions: 0, provider: 'codex', config: { model: 'gpt-5.3-codex' } },
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
    assert.deepStrictEqual(calls.map((call) => ({ provider: call.provider, config: call.config })), [
      { provider: 'claude', config: { model: 'claude-sonnet-4-6' } },
      { provider: 'codex', config: { model: 'gpt-5.3-codex' } },
    ]);
  });

  it('surfaces generator outputs through the live recording callback', async () => {
    const seen: Array<{ id: string; finalText: string; usage?: unknown; costMicroUsd?: number }> = [];

    const result = await runImplementLiveFixture({
      id: 'record-callback',
      ticket: {
        title: 'Expose live generator output for recording',
        description: 'Recording should see the evaluated live result.',
        labels: ['feature'],
      },
      specBundle: [{ path: 'proposal.md', content: '# Proposal' }],
      operatorComments: [],
    } as any, {
      worktreePath: '/tmp/eval-worktree',
      onGeneratorResult: (fixture, recording) => {
        seen.push({ id: fixture.id, ...recording });
      },
      turnRunner: async () => ({
        finalText: JSON.stringify({
          filesWritten: [{ path: 'src/feature.ts', content: 'export const implemented = true;\n' }],
          commitMessage: 'feat: expose recording callback',
          summary: 'Exposes live implement output for recording.',
          followUps: [],
        }),
        usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5 },
        costMicroUsd: 234,
      }),
    });

    assert.strictEqual(result.status, 'produced');
    assert.deepStrictEqual(seen, [{
      id: 'record-callback',
      finalText: JSON.stringify({
        filesWritten: [{ path: 'src/feature.ts', content: 'export const implemented = true;\n' }],
        commitMessage: 'feat: expose recording callback',
        summary: 'Exposes live implement output for recording.',
        followUps: [],
      }),
      usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5 },
      costMicroUsd: 234,
    }]);
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

  it('records judge parse failures as transparent judge errors without discarding the produced live result', async () => {
    const suite = await runImplementLiveSuite([
      {
        id: 'implement-judge-parse-error',
        ticket: { title: 'Judge parse error', description: 'Keep the implementation result, but surface the malformed judge output.', labels: [] },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Preserve generated output' },
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
              commitMessage: 'feat: keep generated output',
              summary: 'Keeps the generated implementation result.',
              followUps: [],
            }),
          };
        }
        return {
          finalText: 'not-json',
        };
      },
    });

    assert.strictEqual(suite.results[0]?.status, 'produced');
    assert.strictEqual((suite.results[0] as any)?.judge?.finalVerdict, 'error');
    assert.match((suite.results[0] as any)?.judge?.attempts[0]?.errorMessage ?? '', /valid JSON/i);
    assert.deepStrictEqual((suite as any).judgeSummary?.byVerdict, { pass: 0, revise: 0, error: 1 });
  });
});