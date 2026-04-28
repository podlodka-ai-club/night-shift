import { describe, it } from 'mocha';
import assert from 'assert';
import { type MoveProjectItemStatusInput } from '../shared';
import {
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

  it('rethrows exhausted agent failures after moving the issue to In progress', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const markers: string[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-failure-test',
          expectedWorkerWarnings: [/agent failed/],
          activities: {
            async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
            async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
            async listIssueComments() { calls.push('listIssueComments:7'); return []; },
            async readOpenSpecChangeFiles() {
              calls.push('readOpenSpecChangeFiles:7');
              return [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '# Tasks' },
              ];
            },
            async runAgentSequence() { calls.push('runAgentSequence:7'); throw new Error('agent failed'); },
            async writeRepositoryFiles() { throw new Error('writeRepositoryFiles should not run after agent failure'); },
            async runQualityGate() { throw new Error('runQualityGate should not run after agent failure'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async upsertIssueComment(input: { marker: string; body: string }) {
              markers.push(input.marker);
              calls.push(`upsertIssueComment:${input.marker}`);
              assert.match(input.body, /implement/i);
              assert.match(input.body, /agent failed/i);
              assert.match(input.body, /Ready/i);
            },
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
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'moveProjectItemStatus:item-1',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'moveProjectItemStatus:item-1',
      'upsertIssueComment:workflow:phase-failure',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
    assert.deepStrictEqual(markers, ['workflow:phase-failure']);
  });

  it('preserves the original workflow failure when commitAndPush fails after the gate passes', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const markers: string[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-commit-failure-test',
          expectedWorkerWarnings: [/commit failed/],
          activities: {
            async getTopReadyIssue() { return issue; },
            async createWorktreeForIssueIfNeeded() { return worktree; },
            async listIssueComments() { return []; },
            async readOpenSpecChangeFiles() {
              return [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '# Tasks' },
              ];
            },
            async runAgentSequence() {
              return {
                threadId: 'thread-123',
                completedStepIds: ['implement'],
                outputs: {
                  implementResponse: {
                    filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }],
                    commitMessage: 'feat: implement the approved spec',
                    summary: 'Implements the approved spec bundle.',
                    followUps: [],
                  },
                },
                finalResponse: JSON.stringify({ implemented: true }),
              };
            },
            async writeRepositoryFiles() { return undefined; },
            async runQualityGate() { return { passed: true, summary: 'ok', logs: '' }; },
            async commitAndPush() { throw new Error('commit failed'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after commit failure'); },
            async upsertIssueComment(input: { marker: string; body: string }) {
              markers.push(input.marker);
              assert.match(input.body, /implement/i);
              assert.match(input.body, /commit failed/i);
              assert.match(input.body, /Ready/i);
            },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
            },
          },
        }),
      (error: unknown) => assertWorkflowActivityFailure(error, /commit failed/),
    );

    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
    assert.deepStrictEqual(markers, ['workflow:phase-failure']);
  });
});