import { describe, it } from 'mocha';
import assert from 'assert';
import { type MoveProjectItemStatusInput } from '../shared';
import {
  buildExpectedCreatedPullRequest,
  buildSelectedIssue,
  buildWorktreeContext,
} from './activity-test-helpers';
import {
  buildStatusUpdateInput,
  createWorkflowTestRig,
} from './workflow-test-helpers';

const { runWorkflow } = createWorkflowTestRig();

describe('workflow success paths', function () {
  this.timeout(60_000);

  it('automates the top ready issue through Temporal', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    const result = await runWorkflow({
      workflowId: 'automate-ready-issue-test',
      activities: createImplementSuccessActivities({ issue, worktree, pullRequest, calls, statusUpdates }),
    });

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
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'moveProjectItemStatus:item-1',
      'runAgentSequence:7',
      'writeRepositoryFiles:7',
      'runQualityGate:7',
      'commitAndPush:orchestrator/issue-7',
      'openPullRequest:orchestrator/issue-7',
      'upsertIssueComment:7',
      'moveProjectItemStatus:item-1',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
    ]);
  });

  it('retries openPullRequest after commitAndPush succeeds without duplicating later side effects', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    let openPullRequestAttempts = 0;

    const result = await runWorkflow({
      workflowId: 'automate-ready-issue-open-pr-retry-test',
      expectedWorkerWarnings: [/transient pull request failure/],
      activities: createImplementSuccessActivities({
        issue,
        worktree,
        pullRequest,
        calls,
        statusUpdates,
        openPullRequest: async () => {
          openPullRequestAttempts += 1;
          if (openPullRequestAttempts === 1) {
            throw new Error('transient pull request failure');
          }
          return pullRequest;
        },
      }),
    });

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(openPullRequestAttempts, 2);
    assert.strictEqual(calls.filter((call) => call === 'commitAndPush:orchestrator/issue-7').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'openPullRequest:orchestrator/issue-7').length, 2);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:7').length, 1);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
    ]);
  });

  it('retries upsertIssueComment after opening the pull request without reopening it', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    let upsertIssueCommentAttempts = 0;

    const result = await runWorkflow({
      workflowId: 'automate-ready-issue-comment-retry-test',
      expectedWorkerWarnings: [/transient summary comment failure/],
      activities: createImplementSuccessActivities({
        issue,
        worktree,
        pullRequest,
        calls,
        statusUpdates,
        upsertIssueComment: async () => {
          upsertIssueCommentAttempts += 1;
          if (upsertIssueCommentAttempts === 1) {
            throw new Error('transient summary comment failure');
          }
        },
      }),
    });

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(upsertIssueCommentAttempts, 2);
    assert.strictEqual(calls.filter((call) => call === 'openPullRequest:orchestrator/issue-7').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:7').length, 2);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
    ]);
  });

  it('retries the final In review status update without reopening the pull request or rewriting the summary', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    let inReviewStatusAttempts = 0;

    const result = await runWorkflow({
      workflowId: 'automate-ready-issue-status-retry-test',
      expectedWorkerWarnings: [/transient in-review status failure/],
      activities: createImplementSuccessActivities({
        issue,
        worktree,
        pullRequest,
        calls,
        statusUpdates,
        moveProjectItemStatus: async (input) => {
          if (input.statusOptionId === issue.inReviewOptionId) {
            inReviewStatusAttempts += 1;
            if (inReviewStatusAttempts === 1) {
              throw new Error('transient in-review status failure');
            }
          }
        },
      }),
    });

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(inReviewStatusAttempts, 2);
    assert.strictEqual(calls.filter((call) => call === 'openPullRequest:orchestrator/issue-7').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:7').length, 1);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
    ]);
  });
});

function createImplementSuccessActivities({
  issue,
  worktree,
  pullRequest,
  calls,
  statusUpdates,
  openPullRequest,
  upsertIssueComment,
  moveProjectItemStatus,
}: {
  issue: ReturnType<typeof buildSelectedIssue>;
  worktree: ReturnType<typeof buildWorktreeContext>;
  pullRequest: ReturnType<typeof buildExpectedCreatedPullRequest>;
  calls: string[];
  statusUpdates: MoveProjectItemStatusInput[];
  openPullRequest?: (input: any) => Promise<any>;
  upsertIssueComment?: (input: any) => Promise<void>;
  moveProjectItemStatus?: (input: MoveProjectItemStatusInput) => Promise<void>;
}) {
  return {
    async getTopReadyIssue() {
      calls.push('getTopReadyIssue');
      return issue;
    },
    async createWorktreeForIssueIfNeeded() {
      calls.push('createWorktreeForIssueIfNeeded:7');
      return worktree;
    },
    async listIssueComments() {
      calls.push('listIssueComments:7');
      return [];
    },
    async readOpenSpecChangeFiles() {
      calls.push('readOpenSpecChangeFiles:7');
      return [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '# Tasks' },
      ];
    },
    async runAgentSequence(input: any) {
      calls.push('runAgentSequence:7');
      assert.strictEqual(input.worktree.issueNumber, 7);
      assert.strictEqual(input.steps.length, 1);
      assert.deepStrictEqual(input.steps.map((step: any) => ({
        id: step.id,
        kind: step.kind,
        resultKey: step.resultKey,
        schemaId: step.schemaId,
      })), [{ id: 'implement', kind: 'structured', resultKey: 'implementResponse', schemaId: 'implement-response-v1' }]);
      assert.match(input.steps[0].prompt, /proposal\.md/);
      assert.match(input.steps[0].prompt, /tasks\.md/);

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
    async writeRepositoryFiles(input: any) {
      calls.push('writeRepositoryFiles:7');
      assert.deepStrictEqual(input.files, [{ path: 'src/index.ts', content: 'export const ok = true;\n' }]);
    },
    async runQualityGate() {
      calls.push('runQualityGate:7');
      return { passed: true, summary: 'make check passed', logs: '' };
    },
    async commitAndPush(input: any) {
      calls.push('commitAndPush:orchestrator/issue-7');
      assert.strictEqual(input.commitMessage, 'feat: implement the approved spec');
    },
    async openPullRequest(input: any) {
      calls.push('openPullRequest:orchestrator/issue-7');
      assert.strictEqual(input.title, '#7: Create a dummy PR');
      assert.match(input.body, /Closes https:\/\/github\.com\/Mugenor\/orchestrator-testing\/issues\/7/);
      assert.match(input.body, /Implements the approved spec bundle\./);
      return openPullRequest ? openPullRequest(input) : pullRequest;
    },
    async upsertIssueComment(input: any) {
      calls.push(`upsertIssueComment:${input.issueNumber}`);
      assert.strictEqual(input.marker, 'implement:summary');
      assert.match(input.body, /Implements the approved spec bundle\./);
      if (upsertIssueComment) {
        await upsertIssueComment(input);
      }
    },
    async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
      statusUpdates.push(input);
      calls.push(`moveProjectItemStatus:${input.projectItemId}`);
      if (moveProjectItemStatus) {
        await moveProjectItemStatus(input);
      }
    },
  };
}