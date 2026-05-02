import assert from 'assert';
import { describe, it } from 'mocha';
import { REVIEWER_RESPONSE_OUTPUT_KEY } from '../shared';
import { buildReviewPrompt } from '../phases/review/prompt';
import { ReviewPhaseContractError } from '../phases/review/errors';
import { decideReviewVerdict, runReviewPhase } from '../phases/review/phase';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';

describe('review phase', () => {
  it('renders the prompt with spec files, changed files, diff truncation, and non-marker review comments', () => {
    const prompt = buildReviewPrompt({
      issue: buildSelectedIssue(),
      changeName: '7-demo-change',
      pullRequest: { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42', headSha: 'abc123', isDraft: false },
      specBundleFiles: [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }],
      diff: `diff --git a/src/index.ts b/src/index.ts\n${'x'.repeat(100)}`,
      changedFiles: [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }],
      reviewComments: [{ id: 1, path: 'src/index.ts', line: 1, body: 'Human note: keep this tiny.' }],
      maxDiffCharacters: 40,
    });

    assert.match(prompt, /proposal\.md/);
    assert.match(prompt, /tasks\.md/);
    assert.match(prompt, /Human note: keep this tiny\./);
    assert.match(prompt, /Diff truncated to 40 characters/);
    assert.match(prompt, /src\/index\.ts/);
  });

  it('decides ready-to-merge for warning-only findings and escalates on the final retry with errors', () => {
    assert.strictEqual(decideReviewVerdict([{ severity: 'warning', message: 'note' }], 0), 'ready-to-merge');
    assert.strictEqual(decideReviewVerdict([{ severity: 'error', message: 'fix it' }], 0), 'needs-fix');
    assert.strictEqual(decideReviewVerdict([{ severity: 'error', message: 'still broken' }], 2), 'escalate');
  });

  it('submits the happy-path review, normalizes absolute finding paths, and falls back from APPROVE to COMMENT when GitHub rejects approval', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];

    const result = await runReviewPhase(
      { issue, worktree, pullRequest },
      {
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }]; },
        async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: true }; },
        async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
        async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
        async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return [{ id: 1, path: 'src/index.ts', line: 1, body: '<!-- night-shift:review:summary -->\nold bot review' }, { id: 2, path: 'src/index.ts', line: 1, body: 'Human note: fine' }]; },
        async runAgentSequence() { calls.push('runAgentSequence'); return { outputs: { [REVIEWER_RESPONSE_OUTPUT_KEY]: { summary: 'Looks good to merge.', findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: `${worktree.worktreePath}/src/index.ts`, line: 1 } }] } } }; },
        async setPullRequestReady() { calls.push('setPullRequestReady'); },
        async createPullRequestReview(input) { calls.push(`createPullRequestReview:${input.event}`); if (input.event === 'APPROVE') throw new Error('422 cannot approve your own pull request'); },
        async upsertPullRequestReviewComment(input) { calls.push(`upsertPullRequestReviewComment:${input.path}:${input.line}`); },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); assert.match(input.body, /ready-to-merge/i); },
        async addIssueLabels() { calls.push('addIssueLabels'); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'ready_to_merge');
    assert.strictEqual(result.verdict, 'ready-to-merge');
    assert.deepStrictEqual(calls, [
      'getPullRequestDetails', 'readOpenSpecChangeFiles', 'getPullRequestDiff', 'listPullRequestFiles', 'listPullRequestReviewComments', 'runAgentSequence',
      'setPullRequestReady', 'createPullRequestReview:APPROVE', 'createPullRequestReview:COMMENT', 'upsertPullRequestReviewComment:src/index.ts:1', 'upsertIssueComment:review:summary', `move:${issue.readyToMergeOptionId}`,
    ]);
  });

  it('adds the escalation label, upserts escalation artifacts, and blocks the item on a final-iteration escalate verdict', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];
    const deps: any = {
      async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return [{ path: 'proposal.md', content: '# Proposal' }]; },
      async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
      async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
      async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+throw new Error();' }]; },
      async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
      async runAgentSequence() {
        calls.push('runAgentSequence');
        return { outputs: { [REVIEWER_RESPONSE_OUTPUT_KEY]: { summary: 'Still needs help from a human reviewer.', findings: [{ severity: 'error', message: 'The implementation still violates the approved contract.', location: { file: 'src/index.ts', line: 1 } }] } } };
      },
      async setPullRequestReady() { calls.push('setPullRequestReady'); },
      async createPullRequestReview(input: { event: string }) { calls.push(`createPullRequestReview:${input.event}`); },
      async upsertPullRequestReviewComment(input: { path: string; line: number }) { calls.push(`upsertPullRequestReviewComment:${input.path}:${input.line}`); },
      async upsertIssueComment(input: { marker: string; body: string }) {
        calls.push(`upsertIssueComment:${input.marker}`);
        assert.match(input.body, /escalate/i);
      },
      async moveProjectItemStatus(input: { statusOptionId: string }) { calls.push(`move:${input.statusOptionId}`); },
      async addIssueLabels(input: { labels: string[] }) { calls.push(`addIssueLabels:${input.labels.join(',')}`); },
    };

    const result = await runReviewPhase(
      { issue, worktree, pullRequest, reviewIteration: 2 },
      deps,
    );

    assert.strictEqual(result.outcome, 'escalated');
    assert.strictEqual(result.verdict, 'escalate');
    assert.deepStrictEqual(calls, [
      'getPullRequestDetails',
      'readOpenSpecChangeFiles',
      'getPullRequestDiff',
      'listPullRequestFiles',
      'listPullRequestReviewComments',
      'runAgentSequence',
      'createPullRequestReview:COMMENT',
      'upsertPullRequestReviewComment:src/index.ts:1',
      'addIssueLabels:night-shift:escalation',
      'upsertIssueComment:review:escalation',
      `move:${issue.blockedOptionId}`,
    ]);
  });

  it('wraps contract failures from the structured review step', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);

    await assert.rejects(
      () => runReviewPhase(
        { issue, worktree, pullRequest },
        {
          async readOpenSpecChangeFiles() { return []; },
          async getPullRequestDetails() { return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { return ''; },
          async listPullRequestFiles() { return []; },
          async listPullRequestReviewComments() { return []; },
          async runAgentSequence() { throw { name: 'AgentContractError', message: 'review contract mismatch' }; },
          async setPullRequestReady() { return undefined; },
          async createPullRequestReview() { return undefined; },
          async upsertPullRequestReviewComment() { return undefined; },
          async upsertIssueComment() { return undefined; },
          async addIssueLabels() { return undefined; },
          async moveProjectItemStatus() { return undefined; },
        },
      ),
      (error: unknown) => error instanceof ReviewPhaseContractError && /review contract mismatch/i.test(error.message),
    );
  });
});
