import { after, before, describe, it } from 'mocha';
import assert from 'assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
import { automateTopReadyIssue } from '../workflows';
import {
  TASK_QUEUE,
  type CreatedPullRequest,
  type IssueCommentInput,
  type MoveProjectItemStatusInput,
  type SelectedProjectIssue,
  type WorktreeContext,
} from '../shared';

describe('workflows', function () {
  this.timeout(60_000);

  let testEnv: TestWorkflowEnvironment;

  before(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  });

  after(async () => {
    await testEnv.teardown();
  });

  it('automates the top ready issue through Temporal', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async getTopReadyIssue() {
          calls.push('getTopReadyIssue');
          return issue;
        },
        async createWorktreeForIssueIfNeeded() {
          calls.push('createWorktreeForIssueIfNeeded:7');
          return worktree;
        },
        async runAgentSequence(input: any) {
          calls.push('runAgentSequence:7');
          assert.strictEqual(input.worktree.issueNumber, 7);
          assert.strictEqual(input.steps.length, 2);
          assert.deepStrictEqual(
            input.steps.map((step: any) => ({
              id: step.id,
              kind: step.kind,
              prompt: step.prompt,
              resultKey: step.resultKey,
              schemaId: step.schemaId,
            })),
            [
              {
                id: 'edit',
                kind: 'prompt',
                prompt: buildTaskImplementationPrompt(worktree.taskDescription),
                resultKey: undefined,
                schemaId: undefined,
              },
              {
                id: 'change-metadata',
                kind: 'structured',
                prompt: buildChangeMetadataPrompt(),
                resultKey: 'changeMetadata',
                schemaId: 'change-metadata-v1',
              },
            ],
          );

          return {
            threadId: 'thread-123',
            completedStepIds: ['edit', 'change-metadata'],
            outputs: {
              changeMetadata: buildGeneratedChangeMetadata(),
            },
            finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          };
        },
        async commitAndPush(input: any) {
          calls.push('commitAndPush:orchestrator/issue-7');
          assert.strictEqual(input.commitMessage, 'feat: generate metadata from Codex');
        },
        async openPullRequest(input: any) {
          calls.push('openPullRequest:orchestrator/issue-7');
          assert.strictEqual(input.title, 'feat: generate commit and PR metadata');
          assert.strictEqual(input.body, '## Summary\n- ask Codex for structured metadata in the same thread');
          return pullRequest;
        },
        async cleanupWorktree() {
          calls.push('cleanupWorktree:orchestrator/issue-7');
        },
        async commentOnIssue(input: IssueCommentInput) {
          calls.push(`commentOnIssue:${input.issueNumber}`);
          assert.deepStrictEqual(input, buildIssueCommentInput(issue, pullRequest));
        },
        async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
          statusUpdates.push(input);
          calls.push(`moveProjectItemStatus:${input.projectItemId}`);
        },
      },
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(automateTopReadyIssue, {
        taskQueue: TASK_QUEUE,
        workflowId: 'automate-ready-issue-test',
        args: [
          {
            projectOwner: 'Mugenor',
            projectNumber: 1,
          },
        ],
      }),
    );

    assert.deepStrictEqual(result, {
      issueNumber: issue.issueNumber,
      issueTitle: issue.issueTitle,
      issueUrl: issue.issueUrl,
      pullRequestNumber: pullRequest.pullRequestNumber,
      pullRequestUrl: pullRequest.pullRequestUrl,
      branchName: pullRequest.branchName,
      filePath: pullRequest.filePath,
      targetStatusName: issue.inReviewStatusName,
    });
    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'runAgentSequence:7',
      'commitAndPush:orchestrator/issue-7',
      'openPullRequest:orchestrator/issue-7',
      'commentOnIssue:7',
      'moveProjectItemStatus:item-1',
      'cleanupWorktree:orchestrator/issue-7',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
    ]);
  });

  it('moves exhausted agent failures to Blocked and preserves the original failure if cleanup also fails', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async getTopReadyIssue() {
          calls.push('getTopReadyIssue');
          return issue;
        },
        async createWorktreeForIssueIfNeeded() {
          calls.push('createWorktreeForIssueIfNeeded:7');
          return worktree;
        },
        async runAgentSequence() {
          calls.push('runAgentSequence:7');
          throw new Error('agent failed');
        },
        async commitAndPush() {
          throw new Error('commit should not run after agent failure');
        },
        async openPullRequest() {
          throw new Error('openPullRequest should not run after agent failure');
        },
        async cleanupWorktree() {
          calls.push('cleanupWorktree:orchestrator/issue-7');
          throw new Error('cleanup failed');
        },
        async commentOnIssue() {
          throw new Error('commentOnIssue should not run after agent failure');
        },
        async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
          statusUpdates.push(input);
          calls.push(`moveProjectItemStatus:${input.projectItemId}`);
        },
      },
    });

    await assert.rejects(
      () =>
        worker.runUntil(
          testEnv.client.workflow.execute(automateTopReadyIssue, {
            taskQueue: TASK_QUEUE,
            workflowId: 'automate-ready-issue-failure-test',
            args: [
              {
                projectOwner: 'Mugenor',
                projectNumber: 1,
              },
            ],
          }),
        ),
      (error: unknown) => {
        assert.match(String(error), /Workflow execution failed/);
        const workflowCause = (error as { cause?: unknown }).cause;
        const activityCause =
          workflowCause && typeof workflowCause === 'object'
            ? (workflowCause as { cause?: unknown }).cause
            : undefined;
        assert.match(String(activityCause), /agent failed/);
        return true;
      },
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
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async getTopReadyIssue() {
          calls.push('getTopReadyIssue');
          return issue;
        },
        async createWorktreeForIssueIfNeeded() {
          calls.push('createWorktreeForIssueIfNeeded:7');
          return worktree;
        },
        async runAgentSequence() {
          calls.push('runAgentSequence:7');
          throw new Error('agent failed');
        },
        async commitAndPush() {
          throw new Error('commit should not run after agent failure');
        },
        async openPullRequest() {
          throw new Error('openPullRequest should not run after agent failure');
        },
        async cleanupWorktree() {
          calls.push('cleanupWorktree:orchestrator/issue-7');
        },
        async commentOnIssue() {
          throw new Error('commentOnIssue should not run after agent failure');
        },
        async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
          statusUpdates.push(input);
          calls.push(`moveProjectItemStatus:${input.projectItemId}`);
        },
      },
    });

    await assert.rejects(
      () =>
        worker.runUntil(
          testEnv.client.workflow.execute(automateTopReadyIssue, {
            taskQueue: TASK_QUEUE,
            workflowId: 'automate-ready-issue-fallback-ready-test',
            args: [
              {
                projectOwner: 'Mugenor',
                projectNumber: 1,
              },
            ],
          }),
        ),
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
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async getTopReadyIssue() {
          return issue;
        },
        async createWorktreeForIssueIfNeeded() {
          return worktree;
        },
        async runAgentSequence() {
          throw new Error('agent failed');
        },
        async commitAndPush() {
          throw new Error('commit should not run after agent failure');
        },
        async openPullRequest() {
          throw new Error('openPullRequest should not run after agent failure');
        },
        async cleanupWorktree() {
          return undefined;
        },
        async commentOnIssue() {
          throw new Error('commentOnIssue should not run after agent failure');
        },
        async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
          if (input.statusOptionId === issue.blockedOptionId) {
            throw new Error('status update failed');
          }
        },
      },
    });

    await assert.rejects(
      () =>
        worker.runUntil(
          testEnv.client.workflow.execute(automateTopReadyIssue, {
            taskQueue: TASK_QUEUE,
            workflowId: 'automate-ready-issue-preserve-root-error-test',
            args: [
              {
                projectOwner: 'Mugenor',
                projectNumber: 1,
              },
            ],
          }),
        ),
      (error: unknown) => {
        assert.match(String(error), /Workflow execution failed/);
        const workflowCause = (error as { cause?: unknown }).cause;
        const activityCause =
          workflowCause && typeof workflowCause === 'object'
            ? (workflowCause as { cause?: unknown }).cause
            : undefined;
        assert.match(String(activityCause), /agent failed/);
        return true;
      },
    );
  });

  it('moves the issue to Blocked when a post-agent step fails', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async getTopReadyIssue() {
          calls.push('getTopReadyIssue');
          return issue;
        },
        async createWorktreeForIssueIfNeeded() {
          calls.push('createWorktreeForIssueIfNeeded:7');
          return worktree;
        },
        async runAgentSequence() {
          calls.push('runAgentSequence:7');
          return {
            threadId: 'thread-123',
            completedStepIds: ['edit', 'change-metadata'],
            outputs: { changeMetadata: buildGeneratedChangeMetadata() },
            finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          };
        },
        async commitAndPush() {
          calls.push('commitAndPush:orchestrator/issue-7');
          throw new Error('commit failed');
        },
        async openPullRequest() {
          throw new Error('openPullRequest should not run after commit failure');
        },
        async cleanupWorktree() {
          calls.push('cleanupWorktree:orchestrator/issue-7');
        },
        async commentOnIssue() {
          throw new Error('commentOnIssue should not run after commit failure');
        },
        async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
          statusUpdates.push(input);
          calls.push(`moveProjectItemStatus:${input.projectItemId}`);
        },
      },
    });

    await assert.rejects(
      () =>
        worker.runUntil(
          testEnv.client.workflow.execute(automateTopReadyIssue, {
            taskQueue: TASK_QUEUE,
            workflowId: 'automate-ready-issue-post-agent-failure-test',
            args: [
              {
                projectOwner: 'Mugenor',
                projectNumber: 1,
              },
            ],
          }),
        ),
      (error: unknown) => {
        assert.match(String(error), /Workflow execution failed/);
        const workflowCause = (error as { cause?: unknown }).cause;
        const activityCause =
          workflowCause && typeof workflowCause === 'object'
            ? (workflowCause as { cause?: unknown }).cause
            : undefined;
        assert.match(String(activityCause), /commit failed/);
        return true;
      },
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

function buildIssueCommentInput(
  issue: SelectedProjectIssue,
  pullRequest: CreatedPullRequest,
): IssueCommentInput {
  return {
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    issueNumber: issue.issueNumber,
    pullRequestUrl: pullRequest.pullRequestUrl,
  };
}

function buildStatusUpdateInput(
  issue: SelectedProjectIssue,
  statusOptionId: string,
): MoveProjectItemStatusInput {
  return {
    projectId: issue.projectId,
    projectItemId: issue.projectItemId,
    statusFieldId: issue.statusFieldId,
    statusOptionId,
  };
}

function buildSelectedIssue(): SelectedProjectIssue {
  return {
    projectId: 'project-1',
    projectItemId: 'item-1',
    statusFieldId: 'status-field',
    readyOptionId: 'ready-option',
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
    blockedOptionId: 'blocked-option',
    issueNumber: 7,
    issueTitle: 'Create a dummy PR',
    taskDescription: 'Implement the requested repository change for issue 7.',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/7',
    repoOwner: 'Mugenor',
    repoName: 'orchestrator-testing',
    defaultBranch: 'main',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
  };
}

function buildWorktreeContext(issue: SelectedProjectIssue): WorktreeContext {
  return {
    issueNumber: issue.issueNumber,
    issueTitle: issue.issueTitle,
    taskDescription: issue.taskDescription,
    issueUrl: issue.issueUrl,
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    defaultBranch: issue.defaultBranch,
    branchName: 'orchestrator/issue-7',
    filePath: 'orchestrator-runs/issue-7.md',
    generatedAt: '2026-04-26T00:00:00.000Z',
    repoRoot: '/tmp/orchestrator/Mugenor/orchestrator-testing',
    worktreePath: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7',
  };
}

function buildPullRequest(worktree: WorktreeContext): CreatedPullRequest {
  return {
    branchName: worktree.branchName,
    filePath: worktree.filePath,
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42',
  };
}

function buildGeneratedChangeMetadata(): Record<string, string> {
  return {
    commitMessage: 'feat: generate metadata from Codex',
    pullRequestTitle: 'feat: generate commit and PR metadata',
    pullRequestBody: '## Summary\n- ask Codex for structured metadata in the same thread',
  };
}
