import { log, proxyActivities } from '@temporalio/workflow';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from './agent-prompts';
import { explainChangeMetadataParseError, parseChangeMetadata } from './change-metadata';
import { CHANGE_METADATA_OUTPUT_KEY } from './shared';
import type * as activities from './activities';
import type {
  AgentSequenceResult,
  AgentStep,
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
  commentOnIssue,
  moveProjectItemStatus,
} = proxyActivities<typeof activities>({
  retry: {
    maximumAttempts: 3,
  },
  startToCloseTimeout: '2 minutes',
});

const { cleanupWorktree } = proxyActivities<typeof activities>({
  retry: {
    maximumAttempts: 1,
  },
  startToCloseTimeout: '2 minutes',
});

const MIN_AGENT_SEQUENCE_TIMEOUT_MINUTES = 10;
const MAX_AGENT_TURN_MINUTES = 4;

export async function automateTopReadyIssue(
  input: AutomateReadyIssueInput,
): Promise<AutomateReadyIssueResult> {
  const issue = await getTopReadyIssue(input);
  await moveProjectItemStatus(buildStatusUpdateInput(issue, issue.inProgressOptionId));
  let worktree: WorktreeContext | undefined;
  let pullRequest: CreatedPullRequest | undefined;
  let workflowError: unknown;
  let cleanupError: unknown;
  let failureStatusUpdateError: unknown;

  try {
    worktree = await createWorktreeForIssueIfNeeded({
      issue,
      branchPrefix: input.branchPrefix,
      filePathPrefix: input.filePathPrefix,
    });
    const agentSteps = buildAgentSteps(worktree);
    const runAgentSequence = getRunAgentSequenceActivity(agentSteps);
    const agentResult = await runAgentSequence({ worktree, steps: agentSteps });
    const changeMetadata = extractChangeMetadata(agentResult);
    await commitAndPush({ worktree, commitMessage: changeMetadata?.commitMessage });
    pullRequest = await openPullRequest({
      worktree,
      title: changeMetadata?.pullRequestTitle,
      body: changeMetadata?.pullRequestBody,
    });

    await commentOnIssue(buildIssueCommentInput(issue, pullRequest));
    await moveProjectItemStatus(buildStatusUpdateInput(issue, issue.inReviewOptionId));
  } catch (error) {
    workflowError = error;
    const failureStatusOptionId = resolveFailureStatusOptionId(issue);

    if (failureStatusOptionId) {
      try {
        await moveProjectItemStatus(buildStatusUpdateInput(issue, failureStatusOptionId));
      } catch (statusError) {
        failureStatusUpdateError = statusError;
      }
    }
  } finally {
    if (worktree) {
      try {
        await cleanupWorktree({ worktree });
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (workflowError) {
    if (failureStatusUpdateError) {
      log.warn('Failed to update project item status after workflow failure', { failureStatusUpdateError });
    }

    throw workflowError;
  }

  if (cleanupError && !pullRequest) {
    throw cleanupError;
  }

  if (cleanupError) {
    log.warn('cleanupWorktree failed after a successful pull request', { cleanupError });
  }

  if (!pullRequest) {
    throw new Error('Pull request creation did not complete.');
  }

  return buildAutomateReadyIssueResult(issue, pullRequest);
}

function resolveFailureStatusOptionId(issue: SelectedProjectIssue): string {
  return issue.blockedOptionId ?? issue.readyOptionId;
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

function buildAgentSteps(worktree: WorktreeContext): [AgentStep, ...AgentStep[]] {
  return [
    {
      id: 'edit',
      kind: 'prompt',
      prompt: buildEditPrompt(worktree),
    },
    {
      id: 'change-metadata',
      kind: 'structured',
      prompt: buildMetadataPrompt(),
      schemaId: 'change-metadata-v1',
      resultKey: CHANGE_METADATA_OUTPUT_KEY,
    },
  ];
}

function getRunAgentSequenceActivity(steps: readonly AgentStep[]) {
  const { runAgentSequence } = proxyActivities<typeof activities>({
    heartbeatTimeout: '60 seconds',
    retry: {
      maximumAttempts: 3,
    },
    startToCloseTimeout: buildRunAgentSequenceStartToCloseTimeout(steps),
  });

  return runAgentSequence;
}

function buildRunAgentSequenceStartToCloseTimeout(steps: readonly AgentStep[]): `${number} minutes` {
  const worstCaseTurnCount = steps.reduce(
    (count, step) => count + (step.kind === 'structured' ? 2 : 1),
    0,
  );
  return `${Math.max(MIN_AGENT_SEQUENCE_TIMEOUT_MINUTES, worstCaseTurnCount * MAX_AGENT_TURN_MINUTES)} minutes`;
}

function buildEditPrompt(worktree: WorktreeContext): string {
  return buildTaskImplementationPrompt(worktree.taskDescription);
}

function buildMetadataPrompt(): string {
  return buildChangeMetadataPrompt();
}

function extractChangeMetadata(agentResult: AgentSequenceResult) {
  const rawChangeMetadata = agentResult.outputs[CHANGE_METADATA_OUTPUT_KEY];
  if (rawChangeMetadata === undefined) {
    return undefined;
  }

  const changeMetadata = parseChangeMetadata(rawChangeMetadata);
  if (!changeMetadata) {
    const detail = explainChangeMetadataParseError(rawChangeMetadata);
    throw new Error(
      detail
        ? `Agent sequence produced invalid change metadata output: ${detail}`
        : 'Agent sequence produced invalid change metadata output.',
    );
  }

  return changeMetadata;
}
