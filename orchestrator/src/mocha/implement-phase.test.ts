import assert from 'assert';
import { describe, it } from 'mocha';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { IMPLEMENT_RESPONSE_OUTPUT_KEY } from '../shared';
import { buildImplementPrompt, IMPLEMENT_SYSTEM_PROMPT } from '../phases/implement/prompt';
import { runImplementPhase } from '../phases/implement/phase';

describe('implement phase', () => {
  it('renders donor-faithful implement prompt markers for spec bundle, review feedback, retry context, project guidance, and response instructions', () => {
    const issue = { ...buildSelectedIssue(), labels: ['backend', 'urgent'] } as any;
    const prompt = buildImplementPrompt({
      issue,
      changeName: '7-demo-change',
      specBundleFiles: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '# Tasks' },
      ],
      issueComments: [
        { id: 1, body: 'Operator note: keep the change set small.', authorLogin: 'operator', createdAt: '2026-05-03T11:00:00Z' } as any,
        { id: 2, body: '<!-- night-shift:implement:summary -->\nold summary' },
      ],
      pullRequestFeedback: {
        reviewBodies: [{ body: '<!-- night-shift:review:summary -->\n## Review requested changes\nPlease tighten the public API.', authorLogin: 'reviewer', createdAt: '2026-05-03T11:20:00Z' }],
        reviewComments: [{ id: 9, body: '<!-- night-shift:review:finding -->\nGuard the undefined path.\n\nRef: spec-7', path: 'src/index.ts', line: 8, authorLogin: 'reviewer', createdAt: '2026-05-03T11:30:00Z' } as any],
      },
      retryFeedback: {
        attempt: 1,
        failure: 'make check failed: src/index.ts(1,1): error TS1005',
      },
      projectExtensionPromptContributions: {
        prepend: ['Run targeted tests before broad verification.'],
        append: ['Prefer existing repo conventions over introducing new abstractions.'],
      },
    });

    assert.match(IMPLEMENT_SYSTEM_PROMPT, /You are the Implementer role in the Night-Shift system\./);
    assert.match(IMPLEMENT_SYSTEM_PROMPT, /Given a product ticket and its approved spec bundle, produce the minimal set/);
    assert.match(IMPLEMENT_SYSTEM_PROMPT, /ENGINEERING HYGIENE — apply when reasoning:/);
    assert.match(IMPLEMENT_SYSTEM_PROMPT, /Your final message MUST be a single JSON object matching the provided schema\./);
    assert.match(prompt, /^<untrusted-input source="github-ticket">[\s\S]*# Ticket 7: Create a dummy PR/m);
    assert.match(prompt, /Labels: backend, urgent/);
    assert.doesNotMatch(prompt, /^Change folder: openspec\/changes\//m);
    assert.match(prompt, /## Spec bundle\n<untrusted-input source="spec-bundle">[\s\S]*### proposal\.md[\s\S]*```markdown[\s\S]*# Proposal/);
    assert.match(prompt, /## Comments\n<untrusted-input source="github-comments">[\s\S]*### @operator — 2026-05-03T11:00:00Z[\s\S]*Operator note: keep the change set small\./);
    assert.doesNotMatch(prompt, /night-shift:implement:summary/);
    assert.match(prompt, /Review requested changes/);
    assert.match(prompt, /Please tighten the public API\./);
    assert.match(prompt, /## Existing review feedback\n<untrusted-input source="github-review-feedback">[\s\S]*### Review 1 — @reviewer — 2026-05-03T11:20:00Z[\s\S]*Review requested changes[\s\S]*### src\/index\.ts:8 — @reviewer — 2026-05-03T11:30:00Z[\s\S]*Guard the undefined path\./);
    assert.match(prompt, /Guard the undefined path\./);
    assert.doesNotMatch(prompt, /night-shift:review:summary/);
    assert.doesNotMatch(prompt, /night-shift:review:finding/);
    assert.match(prompt, /## Retry feedback\n<untrusted-input source="previous-attempt-error">[\s\S]*Previous attempt #1 failed with: make check failed/i);
    assert.match(prompt, /## Project extension guidance\nRun targeted tests before broad verification\.[\s\S]*Prefer existing repo conventions over introducing new abstractions\./);
    assert.match(prompt, /## Response\nReturn a JSON object with keys: `filesWritten`/);
    assert.match(prompt, /`path` MUST be a repo-relative POSIX path; absolute paths and `\.\.` segments are rejected\./);
    assert.ok(prompt.indexOf('## Spec bundle') < prompt.indexOf('## Comments'));
    assert.ok(prompt.indexOf('## Comments') < prompt.indexOf('## Existing review feedback'));
    assert.ok(prompt.indexOf('## Existing review feedback') < prompt.indexOf('## Retry feedback'));
    assert.ok(prompt.indexOf('## Retry feedback') < prompt.indexOf('## Project extension guidance'));
    assert.ok(prompt.indexOf('## Project extension guidance') < prompt.indexOf('## Response'));
  });

  it('retries once after a gate failure, feeds retry feedback into the next prompt, and only performs in-review side effects once', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const qualityGates = [{ id: 'typecheck', run: 'pnpm typecheck' }];
    const calls: string[] = [];
    let runAgentSequenceCallCount = 0;
    let runQualityGateCallCount = 0;

    const result = await runImplementPhase(
      {
        issue,
        agents: {
          default: { provider: 'openai', config: { model: 'gpt-5.4', reasoningEffort: 'high' } },
          implement: { provider: 'anthropic' },
        },
        projectExtensionManifest: {
          prompts: {
            specify: { prepend: ['Specify extension guidance.'], append: [] },
            implement: { prepend: ['Implement extension guidance.'], append: ['Implement trailing guidance.'] },
            review: { prepend: ['Review extension guidance.'], append: [] },
          },
          agentDefaults: { config: { maxTurns: 5 } },
          agents: {
            implement: { config: { model: 'claude-haiku-4-5', temperature: 0.1 } },
          },
          qualityGates,
        },
      },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async listOpenPullRequestFeedback() {
          calls.push('listOpenPullRequestFeedback');
          return {
            reviewBodies: [{ body: '<!-- night-shift:review:summary -->\n## Review requested changes\nPlease wire the retry through the existing helper.', authorLogin: 'reviewer', createdAt: '2026-05-03T11:20:00Z' }],
            reviewComments: [{ id: 9, body: '<!-- night-shift:review:finding -->\nKeep the helper pure.', path: 'src/index.ts', line: 1 }],
          };
        },
        async readOpenSpecChangeFiles() {
          calls.push('readOpenSpecChangeFiles');
          return [
            { path: 'proposal.md', content: '# Proposal' },
            { path: 'tasks.md', content: '# Tasks' },
          ];
        },
        async runAgentSequence(input: any) {
          runAgentSequenceCallCount += 1;
          calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
          assert.deepStrictEqual(input.providerSelection, {
            provider: 'claude',
            config: {
              model: 'claude-haiku-4-5',
              reasoningEffort: 'high',
              maxTurns: 5,
              temperature: 0.1,
            },
          });
          assert.strictEqual(input.steps[0]?.systemPrompt, IMPLEMENT_SYSTEM_PROMPT);
          assert.match(input.steps[0].prompt, /Implement extension guidance\./);
          assert.match(input.steps[0].prompt, /Implement trailing guidance\./);
          assert.doesNotMatch(input.steps[0].prompt, /Specify extension guidance\./);
          assert.doesNotMatch(input.steps[0].prompt, /Review extension guidance\./);
          assert.match(input.steps[0].prompt, /Please wire the retry through the existing helper\./);
          assert.match(input.steps[0].prompt, /Keep the helper pure\./);
          if (runAgentSequenceCallCount === 2) {
            assert.match(input.steps[0].prompt, /Previous attempt #1 failed with: quality gate failed: typecheck/i);
            assert.match(input.steps[0].prompt, /src\/index\.ts\(1,1\): error TS1005/);
          }
          return {
            outputs: {
              [IMPLEMENT_RESPONSE_OUTPUT_KEY]: {
                filesWritten: [{ path: 'src/index.ts', content: `export const attempt = ${runAgentSequenceCallCount};\n` }],
                commitMessage: `feat: implement attempt ${runAgentSequenceCallCount}`,
                summary: runAgentSequenceCallCount === 1 ? 'First attempt summary.' : 'Second attempt summary.',
                followUps: runAgentSequenceCallCount === 1 ? ['Fix the failing typecheck'] : [],
              },
            },
          };
        },
        async writeRepositoryFiles(input: any) {
          calls.push('writeRepositoryFiles');
          assert.deepStrictEqual(input.files, [{ path: 'src/index.ts', content: `export const attempt = ${runAgentSequenceCallCount};\n` }]);
        },
        async runQualityGate(input: any) {
          runQualityGateCallCount += 1;
          calls.push(`runQualityGate:${runQualityGateCallCount}`);
          assert.deepStrictEqual(input.qualityGates, qualityGates);
          if (runQualityGateCallCount === 1) {
            return {
              passed: false,
              summary: 'quality gate failed: typecheck',
              logs: 'src/index.ts(1,1): error TS1005',
            };
          }
          return {
            passed: true,
            summary: 'quality gates passed: typecheck',
            logs: '',
          };
        },
        async commitAndPush(input: any) {
          calls.push('commitAndPush');
          assert.strictEqual(input.commitMessage, 'feat: implement attempt 2');
        },
        async openPullRequest(input: any) {
          calls.push('openPullRequest');
          assert.match(input.title ?? '', /#7: Create a dummy PR/);
          assert.match(input.body ?? '', /Closes https:\/\/github\.com\/Mugenor\/orchestrator-testing\/issues\/7/);
          assert.match(input.body ?? '', /Second attempt summary\./);
          return pullRequest;
        },
        async upsertIssueComment(input: any) {
          calls.push('upsertIssueComment');
          assert.strictEqual(input.marker, 'implement:summary');
          assert.match(input.body, /Second attempt summary\./);
        },
        async moveProjectItemStatus(input: any) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'pr_opened');
    assert.strictEqual(result.pullRequest?.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.strictEqual(runQualityGateCallCount, 2);
    assert.deepStrictEqual(calls, [
      'createWorktree',
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'listOpenPullRequestFeedback',
      `move:${issue.inProgressOptionId}`,
      'runAgentSequence:1',
      'writeRepositoryFiles',
      'runQualityGate:1',
      'runAgentSequence:2',
      'writeRepositoryFiles',
      'runQualityGate:2',
      'commitAndPush',
      'openPullRequest',
      'upsertIssueComment',
      `move:${issue.inReviewOptionId}`,
    ]);
  });

  it('returns needs_input with operator guidance when the approved spec bundle is missing and never attempts best-effort implementation', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];

    const result = await runImplementPhase(
      { issue },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async listOpenPullRequestFeedback() { calls.push('listOpenPullRequestFeedback'); return { reviewBodies: [], reviewComments: [] }; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return [{ path: 'proposal.md', content: '# Proposal' }]; },
        async runAgentSequence() { calls.push('runAgentSequence'); throw new Error('should not run the agent without an approved spec bundle'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'ok', logs: '' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); throw new Error('should not open pull request'); },
        async upsertIssueComment(input: any) {
          calls.push('upsertIssueComment');
          assert.strictEqual(input.marker, 'implement:summary');
          assert.match(input.body, /send the item back through Specify/i);
          assert.match(input.body, /tasks\.md/);
        },
        async moveProjectItemStatus(input: any) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'needs_input');
    assert.match(result.summaryCommentBody, /send the item back through Specify/i);
    assert.deepStrictEqual(calls, [
      'createWorktree',
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'upsertIssueComment',
      `move:${issue.blockedOptionId}`,
    ]);
  });
});
