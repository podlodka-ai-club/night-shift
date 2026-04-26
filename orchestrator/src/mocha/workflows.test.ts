import { after, before, describe, it } from 'mocha';
import assert from 'assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
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
        async runAgent() {
          calls.push('runAgent:7');
        },
        async commitAndPush() {
          calls.push('commitAndPush:orchestrator/issue-7');
        },
        async openPullRequest() {
          calls.push('openPullRequest:orchestrator/issue-7');
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
      'runAgent:7',
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
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
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
