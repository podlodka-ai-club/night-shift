import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setCurrentDetails,
  setHandler,
} from '@temporalio/workflow';
import {
  WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME,
  WORKFLOW_SIGNAL_NAMES,
} from './shared';
import type * as activities from './activities';
import { runImplementPhase } from './phases/implement/phase';
import { runSpecifyPhase } from './phases/specify/phase';
import type {
  AgentStep,
  AutomateReadyIssueInput,
  AutomateReadyIssueResult,
  CreatedPullRequest,
  SelectedProjectIssue,
  WorkflowBlockedReason,
  WorkflowPhase,
} from './shared';

const {
  getTopBacklogIssue,
  getTopReadyIssue,
  createWorktreeForIssueIfNeeded,
  readOpenSpecChangeFiles,
  writeOpenSpecChangeFiles,
  writeRepositoryFiles,
  validateOpenSpecChange,
  runQualityGate,
  commitAndPush,
  openPullRequest,
  listIssueComments,
  upsertIssueComment,
  moveProjectItemStatus,
} = proxyActivities<typeof activities>({
  retry: {
    maximumAttempts: 3,
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
  let selectedSpecifyIssue: SelectedProjectIssue | undefined;
  let selectedImplementIssue: SelectedProjectIssue | undefined;
  let allowSpecReviewed = false;
  let allowSpecifyRetry = false;
  let allowImplementRetry = false;
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
    selectedSpecifyIssue ??= await getTopBacklogIssue(input);
    const issue = selectedSpecifyIssue;
    shellState.issueNumber = issue.issueNumber;
    shellState.issueTitle = issue.issueTitle;
    shellState.latestActivity = `Selected Backlog issue #${issue.issueNumber} for Specify.`;
    syncCurrentDetails();

    const specifyResult = await runSpecifyPhase(
      {
        issue,
        branchPrefix: input.branchPrefix,
        filePathPrefix: input.filePathPrefix,
        onProgress: (message) => {
          shellState.latestActivity = message;
          syncCurrentDetails();
        },
      },
      {
        createWorktreeForIssueIfNeeded,
        listIssueComments,
        readOpenSpecChangeFiles,
        writeOpenSpecChangeFiles,
        validateOpenSpecChange,
        runAgentSequence: (agentInput) => getRunAgentSequenceActivityWithRetry(agentInput.steps, ['AgentContractError'])(agentInput),
        commitAndPush,
        openPullRequest,
        upsertIssueComment,
        moveProjectItemStatus,
      },
    );

    if (specifyResult.outcome === 'needs_input') {
      shellState.blockedReason = 'specify_needs_input';
      shellState.latestActivity = 'Specify phase is blocked on operator input.';
      allowSpecifyRetry = true;
      syncCurrentDetails();
      await condition(() => pendingSpecifyRetry);
      allowSpecifyRetry = false;
      pendingSpecifyRetry = false;
      shellState.blockedReason = null;
      shellState.latestActivity = 'Specify retry requested; rerunning Specify phase.';
      syncCurrentDetails();
      continue;
    }

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
      shellState.blockedReason = null;
      shellState.latestActivity = 'Specify retry requested; rerunning Specify phase.';
      syncCurrentDetails();
      continue;
    }

    pendingSpecReviewed = false;
    selectedImplementIssue = issue;
    selectedSpecifyIssue = undefined;
    shellState.blockedReason = null;
    shellState.currentPhase = 'implement';
    shellState.latestActivity = 'Spec review approved; entering implement phase.';
    syncCurrentDetails();
  }

  if (pendingResume) pendingResume = false;

  while (shellState.currentPhase === 'implement') {
    selectedImplementIssue ??= await getTopReadyIssue(input);
    const issue = selectedImplementIssue;
    shellState.issueNumber = issue.issueNumber;
    shellState.issueTitle = issue.issueTitle;
    shellState.latestActivity = `Selected Ready issue #${issue.issueNumber} for Implement.`;
    syncCurrentDetails();

    const implementResult = await runImplementPhase(
      {
        issue,
        branchPrefix: input.branchPrefix,
        filePathPrefix: input.filePathPrefix,
        onProgress: (message) => {
          shellState.latestActivity = message;
          syncCurrentDetails();
        },
      },
      {
        createWorktreeForIssueIfNeeded,
        listIssueComments,
        readOpenSpecChangeFiles,
        runAgentSequence: (agentInput) => getRunAgentSequenceActivityWithRetry(agentInput.steps, ['AgentContractError'])(agentInput),
        writeRepositoryFiles,
        runQualityGate,
        commitAndPush,
        openPullRequest,
        upsertIssueComment,
        moveProjectItemStatus,
      },
    );

    if (implementResult.outcome === 'needs_input') {
      shellState.blockedReason = 'implement_needs_input';
      shellState.latestActivity = 'Implement phase is blocked on operator input.';
      allowImplementRetry = true;
      syncCurrentDetails();
      await condition(() => pendingImplementRetry);
      allowImplementRetry = false;
      pendingImplementRetry = false;
      shellState.blockedReason = null;
      shellState.latestActivity = 'Implement retry requested; rerunning Implement phase.';
      syncCurrentDetails();
      continue;
    }

    shellState.blockedReason = null;
    shellState.currentPhase = 'review';
    shellState.latestActivity = `Opened PR #${implementResult.pullRequest?.pullRequestNumber} and moved the issue to In review.`;
    syncCurrentDetails();
    if (!implementResult.pullRequest) {
      throw new Error('Implement phase did not return a pull request.');
    }
    return buildAutomateReadyIssueResult(issue, implementResult.pullRequest);
  }

  throw new Error('Workflow exited the implement phase unexpectedly.');
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

function getRunAgentSequenceActivityWithRetry(
  steps: readonly AgentStep[],
  nonRetryableErrorTypes: readonly string[] = [],
) {
  const { runAgentSequence } = proxyActivities<typeof activities>({
    heartbeatTimeout: '60 seconds',
    retry: {
      maximumAttempts: 3,
      ...(nonRetryableErrorTypes.length > 0 ? { nonRetryableErrorTypes: [...nonRetryableErrorTypes] } : {}),
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
