import {
  condition,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setCurrentDetails,
  setHandler,
} from '@temporalio/workflow';
import {
  WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME,
  WORKFLOW_SIGNAL_NAMES,
} from './shared';
import type * as activities from './activities';
import type { IntakeCandidate } from './intake';
import type { PickupWorkflowInput } from './pickup';
import { runImplementPhase } from './phases/implement/phase';
import { runReviewPhase } from './phases/review/phase';
import { runSpecifyPhase } from './phases/specify/phase';
import type {
  AgentStep,
  AutomateReadyIssueInput,
  AutomateReadyIssueResult,
  CreatedPullRequest,
  SelectedProjectIssue,
  WorkflowBlockedReason,
  WorkflowPhase,
  WorktreeContext,
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
  getPullRequestDetails,
  getPullRequestDiff,
  listPullRequestFiles,
  listPullRequestReviewComments,
  setPullRequestReady,
  createPullRequestReview,
  upsertPullRequestReviewComment,
  upsertIssueComment,
  addIssueLabels,
  moveProjectItemStatus,
  cleanupWorktree,
} = proxyActivities<typeof activities>({
  retry: {
    maximumAttempts: 3,
  },
  startToCloseTimeout: '2 minutes',
});

const {
  scanPickupCandidates,
  startPickupWorkflows,
} = proxyActivities<{
  scanPickupCandidates(input: AutomateReadyIssueInput): Promise<IntakeCandidate[]>;
  startPickupWorkflows(input: {
    workflowInput: AutomateReadyIssueInput;
    candidates: IntakeCandidate[];
    maxActions: number;
  }): Promise<unknown>;
}>({
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
  recentActivities: string[];
  issueNumber?: number;
  issueTitle?: string;
}

const MAX_RECENT_ACTIVITIES = 3;

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
  let allowResume = false;
  let pendingSpecReviewed = false;
  let pendingSpecifyRetry = false;
  let pendingImplementRetry = false;
  let pendingResume = false;

  const recordActivity = (message: string): void => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      return;
    }

    shellState.latestActivity = normalizedMessage;
    shellState.recentActivities = appendRecentActivity(shellState.recentActivities, normalizedMessage);
    syncCurrentDetails();
  };

  const syncCurrentDetails = () => {
    setCurrentDetails(renderWorkflowCurrentDetails(shellState));
  };

  const handlePhaseFailure = async (phase: WorkflowPhase, issue: SelectedProjectIssue, error: unknown) => {
    shellState.blockedReason = null;
    recordActivity(`${capitalizePhaseName(phase)} phase failed; issue moved to Blocked.`);
    await moveProjectItemStatus({
      projectId: issue.projectId,
      projectItemId: issue.projectItemId,
      statusFieldId: issue.statusFieldId,
      statusOptionId: issue.blockedOptionId,
    });
    await upsertIssueComment({
      repoOwner: issue.repoOwner,
      repoName: issue.repoName,
      issueNumber: issue.issueNumber,
      marker: 'workflow:phase-failure',
      body: buildPhaseFailureComment(phase, issue, error),
    });
  };

  const preserveOriginalPhaseFailure = async (phase: WorkflowPhase, issue: SelectedProjectIssue, error: unknown) => {
    try {
      await handlePhaseFailure(phase, issue, error);
    } catch {
      // Best-effort cleanup must not replace the original phase failure.
    }
  };

  const cleanupSuccessfulWorktree = async (worktree: WorktreeContext) => {
    try {
      await cleanupWorktree({ worktree });
    } catch (cleanupError) {
      log.warn('cleanupWorktree failed after successful phased workflow completion', {
        cleanupError,
        branchName: worktree.branchName,
      });
    }
  };

  setHandler(getBlockedReasonQuery, () => shellState.blockedReason);
  setHandler(activityProgressSignal, recordActivity);
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
    recordActivity(`Selected Backlog issue #${issue.issueNumber} for Specify.`);

    let specifyResult;
    try {
      specifyResult = await runSpecifyPhase(
        {
          issue,
          branchPrefix: input.branchPrefix,
          onProgress: recordActivity,
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
    } catch (error) {
      await preserveOriginalPhaseFailure('specify', issue, error);
      throw error;
    }

    if (specifyResult.outcome === 'needs_input') {
      shellState.blockedReason = 'specify_needs_input';
      allowSpecifyRetry = true;
      recordActivity('Specify phase is blocked on operator input.');
      await condition(() => pendingSpecifyRetry);
      allowSpecifyRetry = false;
      pendingSpecifyRetry = false;
      shellState.blockedReason = null;
      recordActivity('Specify retry requested; rerunning Specify phase.');
      continue;
    }

    shellState.blockedReason = 'awaiting_spec_review';
    allowSpecReviewed = true;
    allowSpecifyRetry = true;
    recordActivity('Waiting for spec review approval to enter implement mode.');

    await condition(() => pendingSpecReviewed || pendingSpecifyRetry);

    allowSpecReviewed = false;
    allowSpecifyRetry = false;

    if (pendingSpecifyRetry) {
      pendingSpecifyRetry = false;
      shellState.blockedReason = null;
      recordActivity('Specify retry requested; rerunning Specify phase.');
      continue;
    }

    pendingSpecReviewed = false;
    selectedImplementIssue = issue;
    selectedSpecifyIssue = undefined;
    shellState.blockedReason = null;
    shellState.currentPhase = 'implement';
    recordActivity('Spec review approved; entering implement phase.');
  }

  if (pendingResume) pendingResume = false;

  while (shellState.currentPhase === 'implement') {
    selectedImplementIssue ??= await getTopReadyIssue(input);
    const issue = selectedImplementIssue;
    shellState.issueNumber = issue.issueNumber;
    shellState.issueTitle = issue.issueTitle;
    recordActivity(`Selected Ready issue #${issue.issueNumber} for Implement.`);

    let implementResult;
    try {
      implementResult = await runImplementPhase(
        {
          issue,
          branchPrefix: input.branchPrefix,
          onProgress: recordActivity,
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
    } catch (error) {
      await preserveOriginalPhaseFailure('implement', issue, error);
      throw error;
    }

    if (implementResult.outcome === 'needs_input') {
      shellState.blockedReason = 'implement_needs_input';
      allowImplementRetry = true;
      recordActivity('Implement phase is blocked on operator input.');
      await condition(() => pendingImplementRetry);
      allowImplementRetry = false;
      pendingImplementRetry = false;
      shellState.blockedReason = null;
      recordActivity('Implement retry requested; rerunning Implement phase.');
      continue;
    }

    shellState.blockedReason = null;
    shellState.currentPhase = 'review';
    recordActivity(`Opened PR #${implementResult.pullRequest?.pullRequestNumber} and moved the issue to In review.`);
    if (!implementResult.pullRequest) {
      throw new Error('Implement phase did not return a pull request.');
    }

    let reviewResult;
    try {
      reviewResult = await runReviewPhase(
        {
          issue,
          worktree: implementResult.worktree,
          pullRequest: implementResult.pullRequest,
          reviewIteration: shellState.reviewIteration,
          onProgress: recordActivity,
        },
        {
          readOpenSpecChangeFiles,
          getPullRequestDetails,
          getPullRequestDiff,
          listPullRequestFiles,
          listPullRequestReviewComments,
          runAgentSequence: (agentInput) => getRunAgentSequenceActivityWithRetry(agentInput.steps, ['AgentContractError'])(agentInput),
          setPullRequestReady,
          createPullRequestReview,
          upsertPullRequestReviewComment,
          upsertIssueComment,
          addIssueLabels,
          moveProjectItemStatus,
        },
      );
    } catch (error) {
      await preserveOriginalPhaseFailure('review', issue, error);
      throw error;
    }

    if (reviewResult.outcome === 'needs_fix') {
      shellState.reviewIteration += 1;
      shellState.currentPhase = 'implement';
      recordActivity(`Review requested fixes for PR #${implementResult.pullRequest.pullRequestNumber}; rerunning Implement for review iteration ${shellState.reviewIteration + 1}.`);
      continue;
    }

    if (reviewResult.outcome === 'escalated') {
      pendingResume = false;
      shellState.blockedReason = 'review_escalation';
      shellState.currentPhase = 'review';
      allowResume = true;
      recordActivity('Review escalated; waiting for operator resume.');
      await condition(() => pendingResume);
      allowResume = false;
      pendingResume = false;
      shellState.blockedReason = null;
      shellState.reviewIteration = 0;
      shellState.currentPhase = 'implement';
      recordActivity('Resume received; rerunning Implement and restarting the review loop.');
      continue;
    }

    recordActivity(`Review approved PR #${implementResult.pullRequest.pullRequestNumber}; issue moved to Ready to merge.`);
    const result = buildAutomateReadyIssueResult(issue, implementResult.pullRequest, issue.readyToMergeStatusName);
    await cleanupSuccessfulWorktree(implementResult.worktree);
    return result;
  }

  throw new Error('Workflow exited the implement phase unexpectedly.');
}

export async function pickupWorkflow(input: PickupWorkflowInput): Promise<void> {
  const candidates = await scanPickupCandidates(input.workflowInput);
  if (candidates.length === 0) {
    return;
  }
  await startPickupWorkflows({
    workflowInput: input.workflowInput,
    candidates,
    maxActions: input.maxActions,
  });
}

export function renderWorkflowCurrentDetails(state: WorkflowShellState): string {
  return [
    '## Deterministic phases workflow',
    `- Start phase: ${state.startPhase}`,
    `- Current phase: ${state.currentPhase}`,
    `- Blocked reason: ${state.blockedReason ?? 'none'}`,
    `- Review iteration: ${state.reviewIteration}/${state.maxReviewIterations}`,
    `- Latest activity: ${state.latestActivity ?? 'none'}`,
    ...renderRecentActivities(state.recentActivities),
    state.issueNumber !== undefined && state.issueTitle
      ? `- Issue: #${state.issueNumber} ${state.issueTitle}`
      : '- Issue: unresolved',
  ].join('\n');
}

function appendRecentActivity(recentActivities: readonly string[], message: string): string[] {
  if (recentActivities.at(-1) === message) {
    return [...recentActivities];
  }

  return [...recentActivities, message].slice(-MAX_RECENT_ACTIVITIES);
}

function renderRecentActivities(recentActivities: readonly string[]): string[] {
  if (recentActivities.length === 0) {
    return [];
  }

  return ['- Recent summaries:', ...recentActivities.map((activity) => `  - ${activity}`)];
}

function createWorkflowShellState(input: AutomateReadyIssueInput): WorkflowShellState {
  const startPhase = input.startPhase ?? 'implement';
  return {
    startPhase,
    currentPhase: startPhase,
    blockedReason: null,
    reviewIteration: 0,
    maxReviewIterations: 3,
    recentActivities: [],
  };
}

function buildAutomateReadyIssueResult(
  issue: SelectedProjectIssue,
  pullRequest: CreatedPullRequest,
  targetStatusName: string,
): AutomateReadyIssueResult {
  return {
    issueNumber: issue.issueNumber,
    issueTitle: issue.issueTitle,
    issueUrl: issue.issueUrl,
    pullRequestNumber: pullRequest.pullRequestNumber,
    pullRequestUrl: pullRequest.pullRequestUrl,
    branchName: pullRequest.branchName,
    targetStatusName,
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

function buildPhaseFailureComment(phase: WorkflowPhase, issue: SelectedProjectIssue, error: unknown): string {
  const suggestedStatus = phase === 'specify' ? issue.backlogStatusName : issue.readyStatusName;
  return [
    `## Workflow phase failure for #${issue.issueNumber}`,
    `- Phase: ${phase}`,
    `- Root cause: ${describeWorkflowError(error)}`,
    `- Suggested next action: move the item to ${suggestedStatus} after fixing the issue, then retry the workflow from that phase gate.`,
  ].join('\n');
}

function describeWorkflowError(error: unknown): string {
  const visited = new Set<unknown>();
  const parts: string[] = [];
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      parts.push(candidate.message);
    }
    current = candidate.cause;
  }

  if (parts.length > 0) return parts.join('\n');
  return error instanceof Error ? error.message : String(error);
}

function capitalizePhaseName(phase: WorkflowPhase): string {
  return `${phase.slice(0, 1).toUpperCase()}${phase.slice(1)}`;
}
