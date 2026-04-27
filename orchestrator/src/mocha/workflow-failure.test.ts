import { describe, it } from 'mocha';
import assert from 'assert';
import { type MoveProjectItemStatusInput } from '../shared';
import {
  buildGeneratedChangeMetadata,
  buildSelectedIssue,
  buildWorktreeContext,
} from './activity-test-helpers';
import {
  assertWorkflowActivityFailure,
  buildStatusUpdateInput,
  createWorkflowTestRig,
} from './workflow-test-helpers';

const { runWorkflow } = createWorkflowTestRig();

describe('workflow failure paths', function () {
  this.timeout(60_000);

  it('moves exhausted agent failures to Blocked and preserves the original failure if cleanup also fails', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-failure-test',
          expectedWorkerWarnings: [/agent failed/, /cleanup failed/],
          activities: {
            async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
            async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
            async runAgentSequence() { calls.push('runAgentSequence:7'); throw new Error('agent failed'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async cleanupWorktree() { calls.push('cleanupWorktree:orchestrator/issue-7'); throw new Error('cleanup failed'); },
            async commentOnIssue() { throw new Error('commentOnIssue should not run after agent failure'); },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
              calls.push(`moveProjectItemStatus:${input.projectItemId}`);
            },
          },
        }),
      (error: unknown) => assertWorkflowActivityFailure(error, /agent failed/),
    );

    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'moveProjectItemStatus:item-1',
      'cleanupWorktree:orchestrator/issue-7',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId ?? issue.inProgressOptionId),
    ]);
  });

  it('moves exhausted agent failures back to Ready when Blocked is not configured', async () => {
    const calls: string[] = [];
    const issue = { ...buildSelectedIssue(), blockedOptionId: undefined };
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-fallback-ready-test',
          expectedWorkerWarnings: [/agent failed/],
          activities: {
            async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
            async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
            async runAgentSequence() { calls.push('runAgentSequence:7'); throw new Error('agent failed'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async cleanupWorktree() { calls.push('cleanupWorktree:orchestrator/issue-7'); },
            async commentOnIssue() { throw new Error('commentOnIssue should not run after agent failure'); },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
              calls.push(`moveProjectItemStatus:${input.projectItemId}`);
            },
          },
        }),
      /Workflow execution failed/,
    );

    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'moveProjectItemStatus:item-1',
      'cleanupWorktree:orchestrator/issue-7',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.readyOptionId),
    ]);
  });

  it('preserves the original workflow failure when the failure-status update also fails', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-preserve-root-error-test',
          expectedWorkerWarnings: [/agent failed/, /status update failed/],
          activities: {
            async getTopReadyIssue() { return issue; },
            async createWorktreeForIssueIfNeeded() { return worktree; },
            async runAgentSequence() { throw new Error('agent failed'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async cleanupWorktree() { return undefined; },
            async commentOnIssue() { throw new Error('commentOnIssue should not run after agent failure'); },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              if (input.statusOptionId === issue.blockedOptionId) throw new Error('status update failed');
            },
          },
        }),
      (error: unknown) => assertWorkflowActivityFailure(error, /agent failed/),
    );
  });

  it('moves the issue to Blocked when a post-agent step fails', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-post-agent-failure-test',
          expectedWorkerWarnings: [/commit failed/],
          activities: {
            async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
            async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
            async runAgentSequence() {
              calls.push('runAgentSequence:7');
              return {
                threadId: 'thread-123',
                completedStepIds: ['edit', 'change-metadata'],
                outputs: { changeMetadata: buildGeneratedChangeMetadata() },
                finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
              };
            },
            async commitAndPush() { calls.push('commitAndPush:orchestrator/issue-7'); throw new Error('commit failed'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after commit failure'); },
            async cleanupWorktree() { calls.push('cleanupWorktree:orchestrator/issue-7'); },
            async commentOnIssue() { throw new Error('commentOnIssue should not run after commit failure'); },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
              calls.push(`moveProjectItemStatus:${input.projectItemId}`);
            },
          },
        }),
      (error: unknown) => assertWorkflowActivityFailure(error, /commit failed/),
    );

    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'runAgentSequence:7',
      'commitAndPush:orchestrator/issue-7',
      'commitAndPush:orchestrator/issue-7',
      'commitAndPush:orchestrator/issue-7',
      'moveProjectItemStatus:item-1',
      'cleanupWorktree:orchestrator/issue-7',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId ?? issue.readyOptionId),
    ]);
  });
});