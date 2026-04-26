import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';
import type {
  AutomateReadyIssueInput,
  AutomateReadyIssueResult,
  CreatedPullRequest,
  IssueCommentInput,
  MoveProjectItemStatusInput,
  SelectedProjectIssue,
  WorktreeContext,
} from './shared';

const {
  getTopReadyIssue,
  createWorktreeForIssueIfNeeded,
  commitAndPush,
  openPullRequest,
  cleanupWorktree,
  commentOnIssue,
  moveProjectItemStatus,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
});

const { runAgent } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
});

export async function automateTopReadyIssue(
  input: AutomateReadyIssueInput,
): Promise<AutomateReadyIssueResult> {
  const issue = await getTopReadyIssue(input);
  await moveProjectItemStatus(buildStatusUpdateInput(issue, issue.inProgressOptionId));
  let worktree: WorktreeContext | undefined;
  let pullRequest: CreatedPullRequest | undefined;

  try {
    worktree = await createWorktreeForIssueIfNeeded({
      issue,
      branchPrefix: input.branchPrefix,
      filePathPrefix: input.filePathPrefix,
    });
    await runAgent({ worktree });
    await commitAndPush({ worktree });
    pullRequest = await openPullRequest({ worktree });

    await commentOnIssue(buildIssueCommentInput(issue, pullRequest));
    await moveProjectItemStatus(buildStatusUpdateInput(issue, issue.inReviewOptionId));
  } finally {
    if (worktree) {
      await cleanupWorktree({ worktree });
    }
  }

  if (!pullRequest) {
    throw new Error('Pull request creation did not complete.');
  }

  return buildAutomateReadyIssueResult(issue, pullRequest);
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

function buildAutomateReadyIssueResult(
  issue: SelectedProjectIssue,
  pullRequest: CreatedPullRequest,
): AutomateReadyIssueResult {
  return {
    issueNumber: issue.issueNumber,
    issueTitle: issue.issueTitle,
    issueUrl: issue.issueUrl,
    pullRequestNumber: pullRequest.pullRequestNumber,
    pullRequestUrl: pullRequest.pullRequestUrl,
    branchName: pullRequest.branchName,
    filePath: pullRequest.filePath,
    targetStatusName: issue.inReviewStatusName,
  };
}
