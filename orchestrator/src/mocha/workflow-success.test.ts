import { describe, it } from 'mocha';
import assert from 'assert';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
import { type IssueCommentInput, type MoveProjectItemStatusInput } from '../shared';
import {
  buildExpectedCreatedPullRequest,
  buildGeneratedChangeMetadata,
  buildSelectedIssue,
  buildWorktreeContext,
} from './activity-test-helpers';
import {
  buildIssueCommentInput,
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
          assert.deepStrictEqual(
            input.steps.map((step: any) => ({
              id: step.id,
              kind: step.kind,
              prompt: step.prompt,
              resultKey: step.resultKey,
              schemaId: step.schemaId,
            })),
            [
              { id: 'edit', kind: 'prompt', prompt: buildTaskImplementationPrompt(worktree.taskDescription), resultKey: undefined, schemaId: undefined },
              { id: 'change-metadata', kind: 'structured', prompt: buildChangeMetadataPrompt(), resultKey: 'changeMetadata', schemaId: 'change-metadata-v1' },
            ],
          );

          return {
            threadId: 'thread-123',
            completedStepIds: ['edit', 'change-metadata'],
            outputs: { changeMetadata: buildGeneratedChangeMetadata() },
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
});