import {
  condition,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setCurrentDetails,
  setHandler,
} from '@temporalio/workflow';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from './agent-prompts';
import { explainChangeMetadataParseError, parseChangeMetadata } from './change-metadata';
import {
  CHANGE_METADATA_OUTPUT_KEY,
  WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME,
  WORKFLOW_SIGNAL_NAMES,
} from './shared';
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
  WorkflowBlockedReason,
  WorkflowPhase,
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

interface WorkflowShellState {
  startPhase: WorkflowPhase;
  currentPhase: WorkflowPhase;
  blockedReason: WorkflowBlockedReason | null;
  reviewIteration: number;
  maxReviewIterations: number;
  latestActivity?: string;
  issueNumber?: number;
  issueTitle?: string;
}

export const specifyRetrySignal = defineSignal(WORKFLOW_SIGNAL_NAMES[0]);
export const specReviewedSignal = defineSignal(WORKFLOW_SIGNAL_NAMES[1]);
export const implementRetrySignal = defineSignal(WORKFLOW_SIGNAL_NAMES[2]);
export const resumeSignal = defineSignal(WORKFLOW_SIGNAL_NAMES[3]);
export const activityProgressSignal = defineSignal<[string]>(WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME);
export const getBlockedReasonQuery = defineQuery<WorkflowBlockedReason | null>('getBlockedReason');

export async function automateTopReadyIssue(
  input: AutomateReadyIssueInput,
): Promise<AutomateReadyIssueResult> {
  const shellState = createWorkflowShellState(input);
  let allowSpecReviewed = false;
  let allowSpecifyRetry = false;
  // Placeholder scaffolding for later tasks that add implement/review retry loops.
  const allowImplementRetry = false;
  const allowResume = false;
  let pendingSpecReviewed = false;
  let pendingSpecifyRetry = false;
  let pendingImplementRetry = false;
  let pendingResume = false;

  const syncCurrentDetails = () => {
    setCurrentDetails(renderWorkflowCurrentDetails(shellState));
  };

  setHandler(getBlockedReasonQuery, () => shellState.blockedReason);
  setHandler(activityProgressSignal, (message) => {
    shellState.latestActivity = message;
    syncCurrentDetails();
  });
  setHandler(specReviewedSignal, () => {
    if (allowSpecReviewed) pendingSpecReviewed = true;
  });
  setHandler(specifyRetrySignal, () => {
    if (allowSpecifyRetry) pendingSpecifyRetry = true;
  });
  setHandler(implementRetrySignal, () => {
    if (allowImplementRetry) pendingImplementRetry = true;
  });
  setHandler(resumeSignal, () => {
    if (allowResume) pendingResume = true;
  });

  syncCurrentDetails();

  while (shellState.currentPhase === 'specify') {
    shellState.blockedReason = 'awaiting_spec_review';
    shellState.latestActivity = 'Waiting for spec review approval to enter implement mode.';
    allowSpecReviewed = true;
    allowSpecifyRetry = true;
    syncCurrentDetails();

    await condition(() => pendingSpecReviewed || pendingSpecifyRetry);

    allowSpecReviewed = false;
    allowSpecifyRetry = false;

    if (pendingSpecifyRetry) {
      pendingSpecifyRetry = false;
      shellState.latestActivity = 'Specify retry requested; placeholder shell remains in spec review wait state.';
      syncCurrentDetails();
      continue;
    }

    pendingSpecReviewed = false;
    shellState.blockedReason = null;
    shellState.currentPhase = 'implement';
    shellState.latestActivity = 'Spec review approved; entering implement phase.';
    syncCurrentDetails();
  }

  if (pendingImplementRetry) pendingImplementRetry = false;
  if (pendingResume) pendingResume = false;
  shellState.currentPhase = 'implement';
  shellState.blockedReason = null;
  shellState.latestActivity = 'Running implement phase using the current Ready-path mechanics.';
  syncCurrentDetails();

  return runImplementPhase(input, shellState, syncCurrentDetails);
}

export function renderWorkflowCurrentDetails(state: WorkflowShellState): string {
  return [
    '## Deterministic phases workflow',
    `- Start phase: ${state.startPhase}`,
    `- Current phase: ${state.currentPhase}`,
    `- Blocked reason: ${state.blockedReason ?? 'none'}`,
    `- Review iteration: ${state.reviewIteration}/${state.maxReviewIterations}`,
    `- Latest activity: ${state.latestActivity ?? 'none'}`,
    state.issueNumber !== undefined && state.issueTitle
      ? `- Issue: #${state.issueNumber} ${state.issueTitle}`
      : '- Issue: unresolved',
  ].join('\n');
}

function createWorkflowShellState(input: AutomateReadyIssueInput): WorkflowShellState {
  return {
    startPhase: input.startPhase ?? 'implement',
    currentPhase: input.startPhase ?? 'implement',
    blockedReason: null,
    reviewIteration: 0,
    maxReviewIterations: 3,
  };
}

async function runImplementPhase(
  input: AutomateReadyIssueInput,
  shellState: WorkflowShellState,
  syncCurrentDetails: () => void,
): Promise<AutomateReadyIssueResult> {
  const issue = await getTopReadyIssue(input);
  shellState.issueNumber = issue.issueNumber;
  shellState.issueTitle = issue.issueTitle;
  shellState.latestActivity = `Selected Ready issue #${issue.issueNumber}.`;
  syncCurrentDetails();

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
    shellState.latestActivity = `Created or reused worktree for issue #${issue.issueNumber}.`;
    syncCurrentDetails();

    const agentSteps = buildAgentSteps(worktree);
    const runAgentSequence = getRunAgentSequenceActivity(agentSteps);
    const agentResult = await runAgentSequence({ worktree, steps: agentSteps });
    const changeMetadata = extractChangeMetadata(agentResult);
    shellState.latestActivity = 'Structured agent sequence completed.';
    syncCurrentDetails();

    await commitAndPush({ worktree, commitMessage: changeMetadata?.commitMessage });
    pullRequest = await openPullRequest({
      worktree,
      title: changeMetadata?.pullRequestTitle,
      body: changeMetadata?.pullRequestBody,
    });

    await commentOnIssue(buildIssueCommentInput(issue, pullRequest));
    await moveProjectItemStatus(buildStatusUpdateInput(issue, issue.inReviewOptionId));
    shellState.latestActivity = `Opened PR #${pullRequest.pullRequestNumber} and moved the issue to In review.`;
    syncCurrentDetails();
  } catch (error) {
    workflowError = error;
    const failureStatusOptionId = resolveFailureStatusOptionId(issue);
    shellState.blockedReason = 'implement_needs_input';
    shellState.latestActivity = `Implement phase failed: ${String(error)}`;
    syncCurrentDetails();

    try {
      await moveProjectItemStatus(buildStatusUpdateInput(issue, failureStatusOptionId));
    } catch (statusError) {
      failureStatusUpdateError = statusError;
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

  shellState.blockedReason = null;
  shellState.currentPhase = 'review';
  syncCurrentDetails();

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
  return issue.blockedOptionId;
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
