import assert from 'assert';
import { describe, it } from 'mocha';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { IMPLEMENT_RESPONSE_OUTPUT_KEY } from '../shared';
import { buildImplementPrompt } from '../phases/implement/prompt';
import { runImplementPhase } from '../phases/implement/phase';

describe('implement phase', () => {
  it('renders the prompt with the approved spec bundle, operator comments, and retry feedback while filtering Night Shift markers', () => {
    const prompt = buildImplementPrompt({
      issue: buildSelectedIssue(),
      changeName: '7-demo-change',
      specBundleFiles: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '# Tasks' },
      ],
      issueComments: [
        { id: 1, body: 'Operator note: keep the change set small.' },
        { id: 2, body: '<!-- night-shift:implement:summary -->\nold summary' },
      ],
      pullRequestFeedback: {
        reviewBodies: ['<!-- night-shift:review:summary -->\n## Review requested changes\nPlease tighten the public API.'],
        reviewComments: [{ id: 9, body: '<!-- night-shift:review:finding -->\nGuard the undefined path.\n\nRef: spec-7', path: 'src/index.ts', line: 8 }],
      },
      retryFeedback: {
        attempt: 1,
        failure: 'make check failed: src/index.ts(1,1): error TS1005',
      },
    });

    assert.match(prompt, /Operator note: keep the change set small\./);
    assert.doesNotMatch(prompt, /night-shift:implement:summary/);
    assert.match(prompt, /proposal\.md/);
    assert.match(prompt, /# Proposal/);
    assert.match(prompt, /Review requested changes/);
    assert.match(prompt, /Please tighten the public API\./);
    assert.match(prompt, /Inline comment 1 \(src\/index\.ts:8\)/);
    assert.match(prompt, /Guard the undefined path\./);
    assert.doesNotMatch(prompt, /night-shift:review:summary/);
    assert.doesNotMatch(prompt, /night-shift:review:finding/);
    assert.match(prompt, /Previous attempt #1 failed with: make check failed/i);
  });

  it('retries once after a gate failure, feeds retry feedback into the next prompt, and only performs in-review side effects once', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];
    let runAgentSequenceCallCount = 0;
    let runQualityGateCallCount = 0;

    const result = await runImplementPhase(
      { issue },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async listOpenPullRequestFeedback() {
          calls.push('listOpenPullRequestFeedback');
          return {
            reviewBodies: ['<!-- night-shift:review:summary -->\n## Review requested changes\nPlease wire the retry through the existing helper.'],
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
          assert.match(input.steps[0].prompt, /Please wire the retry through the existing helper\./);
          assert.match(input.steps[0].prompt, /Keep the helper pure\./);
          if (runAgentSequenceCallCount === 2) {
            assert.match(input.steps[0].prompt, /Previous attempt #1 failed with: make check failed/i);
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
        async runQualityGate() {
          runQualityGateCallCount += 1;
          calls.push(`runQualityGate:${runQualityGateCallCount}`);
          if (runQualityGateCallCount === 1) {
            return {
              passed: false,
              summary: 'make check failed',
              logs: 'src/index.ts(1,1): error TS1005',
            };
          }
          return {
            passed: true,
            summary: 'make check passed',
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