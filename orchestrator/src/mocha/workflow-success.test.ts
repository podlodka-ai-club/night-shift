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
      targetStatusName: issue.readyToMergeStatusName,
    });
    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'moveProjectItemStatus:item-1',
      'runAgentSequence:1',
      'writeRepositoryFiles:7',
      'runQualityGate:7',
      'commitAndPush:orchestrator/issue-7',
      'openPullRequest:orchestrator/issue-7',
      'upsertIssueComment:implement:summary',
      'moveProjectItemStatus:item-1',
      'getPullRequestDetails:42',
      'readOpenSpecChangeFiles:7',
      'getPullRequestDiff:42',
      'listPullRequestFiles:42',
      'listPullRequestReviewComments:42',
      'runAgentSequence:2',
      'createPullRequestReview:APPROVE',
      'upsertPullRequestReviewComment:src/index.ts:1',
      'upsertIssueComment:review:summary',
      'moveProjectItemStatus:item-1',
      'cleanupWorktree:orchestrator/issue-7',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
      buildStatusUpdateInput(issue, issue.readyToMergeOptionId),
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
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:implement:summary').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:review:summary').length, 1);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
      buildStatusUpdateInput(issue, issue.readyToMergeOptionId),
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
    assert.strictEqual(upsertIssueCommentAttempts, 3);
    assert.strictEqual(calls.filter((call) => call === 'openPullRequest:orchestrator/issue-7').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:implement:summary').length, 2);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:review:summary').length, 1);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
      buildStatusUpdateInput(issue, issue.readyToMergeOptionId),
    ]);
  });

  it('retries the final Ready to merge status update without reopening the pull request or rewriting summaries', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    let readyToMergeStatusAttempts = 0;

    const result = await runWorkflow({
      workflowId: 'automate-ready-issue-status-retry-test',
      expectedWorkerWarnings: [/transient ready-to-merge status failure/],
      activities: createImplementSuccessActivities({
        issue,
        worktree,
        pullRequest,
        calls,
        statusUpdates,
        moveProjectItemStatus: async (input) => {
          if (input.statusOptionId === issue.readyToMergeOptionId) {
            readyToMergeStatusAttempts += 1;
            if (readyToMergeStatusAttempts === 1) {
              throw new Error('transient ready-to-merge status failure');
            }
          }
        },
      }),
    });

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(readyToMergeStatusAttempts, 2);
    assert.strictEqual(calls.filter((call) => call === 'openPullRequest:orchestrator/issue-7').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:implement:summary').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment:review:summary').length, 1);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.inReviewOptionId),
      buildStatusUpdateInput(issue, issue.readyToMergeOptionId),
      buildStatusUpdateInput(issue, issue.readyToMergeOptionId),
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
  cleanupWorktree,
}: {
  issue: ReturnType<typeof buildSelectedIssue>;
  worktree: ReturnType<typeof buildWorktreeContext>;
  pullRequest: ReturnType<typeof buildExpectedCreatedPullRequest>;
  calls: string[];
  statusUpdates: MoveProjectItemStatusInput[];
  openPullRequest?: (input: any) => Promise<any>;
  upsertIssueComment?: (input: any) => Promise<void>;
  moveProjectItemStatus?: (input: MoveProjectItemStatusInput) => Promise<void>;
  cleanupWorktree?: (input: any) => Promise<void>;
}) {
  let runAgentSequenceCallCount = 0;

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
      runAgentSequenceCallCount += 1;
      calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
      assert.strictEqual(input.worktree.issueNumber, 7);
      assert.strictEqual(input.steps.length, 1);

      if (runAgentSequenceCallCount === 1) {
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
      }

      assert.deepStrictEqual(input.steps.map((step: any) => ({
        id: step.id,
        kind: step.kind,
        resultKey: step.resultKey,
        schemaId: step.schemaId,
      })), [{ id: 'review', kind: 'structured', resultKey: 'reviewerResponse', schemaId: 'reviewer-response-v1' }]);
      assert.match(input.steps[0].prompt, /## PR Diff/);
      return {
        threadId: 'thread-review-123',
        completedStepIds: ['review'],
        outputs: {
          reviewerResponse: {
            summary: 'Looks ready to merge with one note.',
            findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }],
          },
        },
        finalResponse: JSON.stringify({ reviewed: true }),
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
    async getPullRequestDetails(input: any) {
      calls.push(`getPullRequestDetails:${input.pullRequestNumber}`);
      return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false };
    },
    async getPullRequestDiff(input: any) {
      calls.push(`getPullRequestDiff:${input.pullRequestNumber}`);
      return ['diff --git a/src/index.ts b/src/index.ts', '--- /dev/null', '+++ b/src/index.ts', '@@', '+export const ok = true;'].join('\n');
    },
    async listPullRequestFiles(input: any) {
      calls.push(`listPullRequestFiles:${input.pullRequestNumber}`);
      return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }];
    },
    async listPullRequestReviewComments(input: any) {
      calls.push(`listPullRequestReviewComments:${input.pullRequestNumber}`);
      return [];
    },
    async setPullRequestReady() {
      calls.push('setPullRequestReady');
    },
    async createPullRequestReview(input: any) {
      calls.push(`createPullRequestReview:${input.event}`);
    },
    async upsertPullRequestReviewComment(input: any) {
      calls.push(`upsertPullRequestReviewComment:${input.path}:${input.line}`);
    },
    async upsertIssueComment(input: any) {
      calls.push(`upsertIssueComment:${input.marker}`);
      if (input.marker === 'implement:summary') {
        assert.match(input.body, /Implements the approved spec bundle\./);
      } else {
        assert.match(input.body, /ready-to-merge/i);
      }
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
    async cleanupWorktree(input: any) {
      calls.push(`cleanupWorktree:${input.worktree.branchName}`);
      if (cleanupWorktree) {
        await cleanupWorktree(input);
      }
    },
  };
}