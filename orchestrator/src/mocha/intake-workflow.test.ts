import assert from 'assert';
import { describe, it } from 'mocha';
import type { WorkflowHandle } from '@temporalio/client';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { createWorkflowTestRig } from './workflow-test-helpers';
import { TASK_QUEUE } from '../shared';
import { automateTopReadyIssue, getBlockedReasonQuery, implementRetrySignal, specReviewedSignal } from '../workflows';
import { createTemporalWorkflowTriggerDeps, handleWorkflowTrigger } from '../intake';

const { runWithWorkflowClient } = createWorkflowTestRig();

describe('intake workflow integration', function () {
  this.timeout(60_000);

  it('signals a blocked Ready workflow instead of starting a duplicate', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopReadyIssueCallCount = 0;
    let readOpenSpecChangeFilesCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWithWorkflowClient(
      {
        workflowId: 'intake-workflow-ready-signal-test',
        activities: buildImplementRetryActivities(issue, worktree, pullRequest, {
          onGetTopReadyIssue() { getTopReadyIssueCallCount += 1; },
          onReadOpenSpecChangeFiles() { readOpenSpecChangeFilesCallCount += 1; return readOpenSpecChangeFilesCallCount; },
          onRunAgentSequence() { runAgentSequenceCallCount += 1; return runAgentSequenceCallCount; },
        }),
      },
      async (workflowClient) => {
        const handle = await workflowClient.start(automateTopReadyIssue, {
          taskQueue: TASK_QUEUE,
          workflowId: 'ticket-7',
          args: [{ projectOwner: 'Mugenor', projectNumber: 1, startPhase: 'implement' }],
        });

        assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
        const action = await handleWorkflowTrigger(
          createTemporalWorkflowTriggerDeps(workflowClient),
          { projectOwner: 'Mugenor', projectNumber: 1 },
          { issue, boardStatusName: 'Ready', createdAt: '2026-04-28T09:00:00.000Z' },
        );
        assert.deepStrictEqual(action, { type: 'signal', workflowId: 'ticket-7', signalName: 'implementRetry' });
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopReadyIssueCallCount, 1);
    assert.ok(readOpenSpecChangeFilesCallCount >= 2, `Expected the resumed workflow to re-read the spec bundle, got ${readOpenSpecChangeFilesCallCount} reads.`);
    assert.ok(runAgentSequenceCallCount >= 2, `Expected the resumed workflow to execute at least implement + review, got ${runAgentSequenceCallCount} agent turns.`);
  });

  it('sends implement-needs-input workflows back through Specify when the item is moved to Backlog', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopBacklogIssueCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWithWorkflowClient(
      {
        workflowId: 'intake-workflow-noop-test',
        activities: buildSpecifyRestartActivities(issue, worktree, pullRequest, {
          onGetTopBacklogIssue() { getTopBacklogIssueCallCount += 1; },
          onRunAgentSequence() { runAgentSequenceCallCount += 1; return runAgentSequenceCallCount; },
        }),
      },
      async (workflowClient) => {
        const handle = await workflowClient.start(automateTopReadyIssue, {
          taskQueue: TASK_QUEUE,
          workflowId: 'ticket-7',
          args: [{ projectOwner: 'Mugenor', projectNumber: 1, startPhase: 'implement' }],
        });

        assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
        const action = await handleWorkflowTrigger(
          createTemporalWorkflowTriggerDeps(workflowClient),
          { projectOwner: 'Mugenor', projectNumber: 1 },
          { issue, boardStatusName: 'Backlog', createdAt: '2026-04-28T09:00:00.000Z' },
        );
        assert.deepStrictEqual(action, { type: 'signal', workflowId: 'ticket-7', signalName: 'specifyRetry' });
        assert.strictEqual(await waitForBlockedReason(handle, 'awaiting_spec_review'), 'awaiting_spec_review');
        await handle.signal(specReviewedSignal);
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopBacklogIssueCallCount, 0);
    assert.strictEqual(runAgentSequenceCallCount, 3);
  });
});

function buildImplementRetryActivities(
  issue: ReturnType<typeof buildSelectedIssue>,
  worktree: ReturnType<typeof buildWorktreeContext>,
  pullRequest: ReturnType<typeof buildExpectedCreatedPullRequest>,
  hooks: {
    onGetTopReadyIssue(): void;
    onReadOpenSpecChangeFiles(): number;
    onRunAgentSequence(): number;
  },
) {
  return {
    async getTopReadyIssue() { hooks.onGetTopReadyIssue(); return issue; },
    async createWorktreeForIssueIfNeeded() { return worktree; },
    async listIssueComments() { return []; },
    async readOpenSpecChangeFiles() {
      return hooks.onReadOpenSpecChangeFiles() === 1 ? [] : [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }];
    },
    async runAgentSequence() {
      return hooks.onRunAgentSequence() === 1
        ? {
            threadId: 'implement-thread-123',
            completedStepIds: ['implement'],
            outputs: { implementResponse: { filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }], commitMessage: 'feat: implement the approved spec', summary: 'Implements the approved spec bundle.', followUps: [] } } as any,
            finalResponse: JSON.stringify({ implemented: true }),
          }
        : {
            threadId: 'review-thread-123',
            completedStepIds: ['review'],
            outputs: { reviewerResponse: { summary: 'Looks ready to merge.', findings: [] } } as any,
            finalResponse: JSON.stringify({ reviewed: true }),
          };
    },
    async writeRepositoryFiles() { return undefined; },
    async runQualityGate() { return { passed: true, summary: 'ok', logs: '' }; },
    async commitAndPush() { return undefined; },
    async openPullRequest() { return pullRequest; },
    async upsertIssueComment() { return undefined; },
    async getPullRequestDetails() { return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
    async getPullRequestDiff() { return 'diff --git a/src/index.ts b/src/index.ts'; },
    async listPullRequestFiles() { return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
    async listPullRequestReviewComments() { return []; },
    async setPullRequestReady() { return undefined; },
    async createPullRequestReview() { return undefined; },
    async upsertPullRequestReviewComment() { return undefined; },
    async moveProjectItemStatus() { return undefined; },
  };
}

function buildSpecifyRestartActivities(
  issue: ReturnType<typeof buildSelectedIssue>,
  worktree: ReturnType<typeof buildWorktreeContext>,
  pullRequest: ReturnType<typeof buildExpectedCreatedPullRequest>,
  hooks: {
    onGetTopBacklogIssue(): void;
    onRunAgentSequence(): number;
  },
) {
  let readOpenSpecChangeFilesCallCount = 0;

  return {
    async getTopReadyIssue() { return issue; },
    async getTopBacklogIssue() { hooks.onGetTopBacklogIssue(); return issue; },
    async createWorktreeForIssueIfNeeded() { return worktree; },
    async listIssueComments() { return []; },
    async readOpenSpecChangeFiles() {
      readOpenSpecChangeFilesCallCount += 1;
      if (readOpenSpecChangeFilesCallCount <= 2) {
        return [];
      }
      return [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }];
    },
    async runAgentSequence() {
      const runAgentSequenceCallCount = hooks.onRunAgentSequence();
      return runAgentSequenceCallCount === 1
        ? {
            threadId: 'specify-thread-123',
            completedStepIds: ['specify'],
            outputs: {
              specifyResponse: {
                files: [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }],
                openQuestions: [],
                assumptions: [],
                risks: [],
              },
            } as any,
            finalResponse: JSON.stringify({ refined: true }),
          }
        : runAgentSequenceCallCount === 2
          ? {
              threadId: 'implement-thread-123',
              completedStepIds: ['implement'],
              outputs: { implementResponse: { filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }], commitMessage: 'feat: implement the approved spec', summary: 'Implements the approved spec bundle.', followUps: [] } } as any,
              finalResponse: JSON.stringify({ implemented: true }),
            }
          : {
              threadId: 'review-thread-123',
              completedStepIds: ['review'],
              outputs: { reviewerResponse: { summary: 'Looks ready to merge.', findings: [] } } as any,
              finalResponse: JSON.stringify({ reviewed: true }),
            };
    },
    async writeOpenSpecChangeFiles() { return undefined; },
    async validateOpenSpecChange() { return undefined; },
    async writeRepositoryFiles() { return undefined; },
    async runQualityGate() { return { passed: true, summary: 'ok', logs: '' }; },
    async commitAndPush() { return undefined; },
    async openPullRequest() { return pullRequest; },
    async upsertIssueComment() { return undefined; },
    async getPullRequestDetails() { return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
    async getPullRequestDiff() { return 'diff --git a/src/index.ts b/src/index.ts'; },
    async listPullRequestFiles() { return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
    async listPullRequestReviewComments() { return []; },
    async setPullRequestReady() { return undefined; },
    async createPullRequestReview() { return undefined; },
    async upsertPullRequestReviewComment() { return undefined; },
    async moveProjectItemStatus() { return undefined; },
  };
}

async function waitForBlockedReason(
  handle: WorkflowHandle<typeof automateTopReadyIssue>,
  expectedBlockedReason: string,
): Promise<string> {
  for (let attempt = 0; attempt < 320; attempt += 1) {
    const blockedReason = await handle.query(getBlockedReasonQuery);
    if (blockedReason === expectedBlockedReason) return blockedReason;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new assert.AssertionError({ message: `Timed out waiting for ${expectedBlockedReason} blocked reason.` });
}