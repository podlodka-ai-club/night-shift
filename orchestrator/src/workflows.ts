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
  assertIssueMatchesExpectedRepo,
  WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME,
  WORKFLOW_SIGNAL_NAMES,
} from './shared';
import type * as activities from './activities';
import type { IntakeCandidate } from './intake';
import type { PickupWorkflowInput } from './pickup';
import { runEscalationPhase } from './phases/escalation/phase';
import { runImplementPhase } from './phases/implement/phase';
import { runReviewPhase } from './phases/review/phase';
import { runSpecifyPhase } from './phases/specify/phase';
import type {
  AgentStep,
  AutomateReadyIssueInput,
  AutomateReadyIssueResult,
  CreatedPullRequest,
  ProjectExtensionManifest,
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
  listOpenPullRequestFeedback,
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

const { loadProjectExtensionManifest } = proxyActivities<Pick<typeof activities, 'loadProjectExtensionManifest'>>({
  retry: {
    maximumAttempts: 1,
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
  currentPhase: WorkflowRuntimePhase;
  blockedReason: WorkflowBlockedReason | null;
  reviewIteration: number;
  maxReviewIterations: number;
  escalationAttemptCount?: number;
  escalationOriginPhase?: WorkflowPhase;
  latestActivity?: string;
  recentActivities: string[];
  issueNumber?: number;
  issueTitle?: string;
}

type WorkflowRuntimePhase = WorkflowPhase | 'escalation';
type ReviewResumeMode = 'implement' | 'review-only';

const MAX_RECENT_ACTIVITIES = 3;

export const specifyRetrySignal = defineSignal(WORKFLOW_SIGNAL_NAMES[0]);
export const specReviewedSignal = defineSignal(WORKFLOW_SIGNAL_NAMES[1]);
export const implementRetrySignal = defineSignal(WORKFLOW_SIGNAL_NAMES[2]);
export const resumeSignal = defineSignal(WORKFLOW_SIGNAL_NAMES[3]);
export const resumeReviewOnlySignal = defineSignal(WORKFLOW_SIGNAL_NAMES[4]);
export const activityProgressSignal = defineSignal<[string]>(WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME);
export const getBlockedReasonQuery = defineQuery<WorkflowBlockedReason | null>('getBlockedReason');

export async function automateTopReadyIssue(
  input: AutomateReadyIssueInput,
): Promise<AutomateReadyIssueResult> {
  const shellState = createWorkflowShellState(input);
  let selectedSpecifyIssue: SelectedProjectIssue | undefined;
  let selectedImplementIssue: SelectedProjectIssue | undefined;
  let activeWorktree: WorktreeContext | undefined;
  let activePullRequest: CreatedPullRequest | undefined;
  let projectExtensionManifest: ProjectExtensionManifest | undefined;
  let allowSpecReviewed = false;
  let allowSpecifyRetry = false;
  let allowImplementRetry = false;
  let allowResume = false;
  let allowResumeReviewOnly = false;
  let pendingSpecReviewed = false;
  let pendingSpecifyRetry = false;
  let pendingImplementRetry = false;
  let pendingResume = false;
  let pendingResumeReviewOnly = false;

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

  const ensureProjectExtensionManifest = async (worktree: WorktreeContext): Promise<ProjectExtensionManifest> => {
    projectExtensionManifest ??= await loadProjectExtensionManifest({ worktree });
    return projectExtensionManifest;
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
  setHandler(resumeReviewOnlySignal, () => {
    if (allowResumeReviewOnly) pendingResumeReviewOnly = true;
  });

  syncCurrentDetails();

  const escalatePhase = async (
    originPhase: WorkflowPhase,
    issue: SelectedProjectIssue,
    options: {
      blockedReason?: WorkflowBlockedReason;
      failureSummary: string;
      worktree?: WorktreeContext;
      pullRequest?: CreatedPullRequest;
    },
  ): Promise<
    | { kind: 'resolved'; nextPhase: WorkflowPhase; worktree: WorktreeContext; pullRequest?: CreatedPullRequest; message: string }
    | { kind: 'blocked'; blockedReason: WorkflowBlockedReason; reviewResumeMode?: ReviewResumeMode; message: string }
  > => {
    shellState.currentPhase = 'escalation';
    shellState.blockedReason = null;
    shellState.escalationOriginPhase = originPhase;
    shellState.escalationAttemptCount = (shellState.escalationAttemptCount ?? 0) + 1;
    recordActivity(`Escalation attempt ${shellState.escalationAttemptCount} started for ${capitalizePhaseName(originPhase)}.`);
    await moveProjectItemStatus({
      projectId: issue.projectId,
      projectItemId: issue.projectItemId,
      statusFieldId: issue.statusFieldId,
      statusOptionId: issue.escalatedOptionId,
    });

    const escalationResult = await runEscalationPhase(
      {
        issue,
        originPhase,
        blockedReason: options.blockedReason,
        failureSummary: options.failureSummary,
        branchPrefix: input.branchPrefix,
        worktree: options.worktree,
        pullRequest: options.pullRequest,
        onProgress: recordActivity,
      },
      {
        createWorktreeForIssueIfNeeded,
        listIssueComments,
        readOpenSpecChangeFiles,
        getPullRequestDetails,
        getPullRequestDiff,
        listPullRequestFiles,
        listPullRequestReviewComments,
        runAgentSequence: (agentInput) => getRunAgentSequenceActivityWithRetry(agentInput.steps, ['AgentContractError'])(agentInput),
        writeOpenSpecChangeFiles,
        writeRepositoryFiles,
        validateOpenSpecChange,
        runQualityGate: ({ worktree }) => runQualityGate({ worktree, qualityGates: projectExtensionManifest?.qualityGates ?? [] }),
        commitAndPush,
        openPullRequest,
        upsertIssueComment,
        moveProjectItemStatus,
      },
    );

    shellState.escalationOriginPhase = undefined;

    if (escalationResult.outcome === 'needs_human') {
      const recommendedStatus = escalationResult.response?.humanRequest?.recommendedStatusAfterAnswer ?? escalationResult.response?.resolution.resumeStatus;
      const humanFallback = resolveHumanFallback(originPhase, recommendedStatus);
      return {
        kind: 'blocked',
        blockedReason: humanFallback.blockedReason,
        reviewResumeMode: humanFallback.reviewResumeMode,
        message: `Escalation requires human input before ${capitalizePhaseName(humanFallback.nextPhase)} can resume.`,
      };
    }

    if (originPhase === 'specify') {
      return {
        kind: 'resolved',
        nextPhase: 'specify',
        worktree: escalationResult.worktree,
        pullRequest: escalationResult.pullRequest,
        message: 'Escalation resolved the Specify block and returned the issue to Backlog for a Specify rerun.',
      };
    }

    if (originPhase === 'implement') {
      return {
        kind: 'resolved',
        nextPhase: 'implement',
        worktree: escalationResult.worktree,
        pullRequest: escalationResult.pullRequest,
        message: 'Escalation resolved the Implement block and returned the issue to Ready for an Implement rerun.',
      };
    }

    if (escalationResult.resumeStatus === 'In review') {
      return {
        kind: 'resolved',
        nextPhase: 'review',
        worktree: escalationResult.worktree,
        pullRequest: escalationResult.pullRequest ?? options.pullRequest,
        message: 'Escalation resolved stale review context and will rerun Review without another Implement pass.',
      };
    }

    return {
      kind: 'resolved',
      nextPhase: 'implement',
      worktree: escalationResult.worktree,
      pullRequest: escalationResult.pullRequest ?? options.pullRequest,
      message: 'Escalation repaired review-state issues with repository changes and will rerun Implement before Review.',
    };
  };

  const applyResolvedEscalation = (
    issue: SelectedProjectIssue,
    result: { nextPhase: WorkflowPhase; worktree: WorktreeContext; pullRequest?: CreatedPullRequest; message: string },
  ) => {
    shellState.blockedReason = null;
    shellState.reviewIteration = 0;
    shellState.currentPhase = result.nextPhase;
    activeWorktree = result.worktree;
    activePullRequest = result.pullRequest ?? activePullRequest;
    if (result.nextPhase === 'specify') {
      selectedSpecifyIssue = issue;
      selectedImplementIssue = undefined;
      activePullRequest = undefined;
    } else {
      selectedSpecifyIssue = undefined;
      selectedImplementIssue = issue;
    }
    recordActivity(result.message);
  };

  const waitForHumanFallback = async (
    issue: SelectedProjectIssue,
    blockedReason: WorkflowBlockedReason,
    reviewResumeMode: ReviewResumeMode | undefined,
  ): Promise<void> => {
    shellState.blockedReason = blockedReason;
    if (blockedReason === 'specify_needs_input') {
      allowSpecifyRetry = true;
      recordActivity('Escalation handed off to a human; waiting for Backlog retry into Specify.');
      await condition(() => pendingSpecifyRetry);
      allowSpecifyRetry = false;
      pendingSpecifyRetry = false;
      shellState.blockedReason = null;
      shellState.currentPhase = 'specify';
      selectedSpecifyIssue = issue;
      selectedImplementIssue = undefined;
      activePullRequest = undefined;
      recordActivity('Specify retry requested after human escalation fallback; returning to Specify phase.');
      return;
    }

    if (blockedReason === 'implement_needs_input') {
      allowSpecifyRetry = true;
      allowImplementRetry = true;
      recordActivity('Escalation handed off to a human; waiting for Backlog or Ready retry into Specify or Implement.');
      await condition(() => pendingSpecifyRetry || pendingImplementRetry);
      allowSpecifyRetry = false;
      allowImplementRetry = false;
      if (pendingSpecifyRetry) {
        pendingSpecifyRetry = false;
        pendingImplementRetry = false;
        shellState.blockedReason = null;
        shellState.currentPhase = 'specify';
        selectedSpecifyIssue = issue;
        selectedImplementIssue = undefined;
        activePullRequest = undefined;
        recordActivity('Backlog retry requested after human escalation fallback; returning to Specify phase.');
        return;
      }

      pendingImplementRetry = false;
      shellState.blockedReason = null;
      shellState.currentPhase = 'implement';
      selectedSpecifyIssue = undefined;
      selectedImplementIssue = issue;
      recordActivity('Implement retry requested after human escalation fallback; rerunning Implement phase.');
      return;
    }

    allowResume = reviewResumeMode === 'implement';
    allowResumeReviewOnly = reviewResumeMode === 'review-only';
    recordActivity(reviewResumeMode === 'review-only'
      ? 'Escalation handed off to a human; waiting for In review resume into Review.'
      : 'Escalation handed off to a human; waiting for Ready resume into Implement.');
    await condition(() => pendingResume || pendingResumeReviewOnly);
    allowResume = false;
    allowResumeReviewOnly = false;

    if (pendingResumeReviewOnly) {
      pendingResumeReviewOnly = false;
      pendingResume = false;
      shellState.blockedReason = null;
      shellState.reviewIteration = 0;
      shellState.currentPhase = 'review';
      selectedSpecifyIssue = undefined;
      selectedImplementIssue = issue;
      recordActivity('Review-only resume received after human escalation fallback; rerunning Review.');
      return;
    }

    pendingResume = false;
    shellState.blockedReason = null;
    shellState.reviewIteration = 0;
    shellState.currentPhase = 'implement';
    selectedSpecifyIssue = undefined;
    selectedImplementIssue = issue;
    recordActivity('Resume received after human escalation fallback; rerunning Implement and restarting the review loop.');
  };

  const attemptEscalationAfterPhaseFailure = async (
    phase: WorkflowPhase,
    issue: SelectedProjectIssue,
    error: unknown,
  ): Promise<boolean> => {
    try {
      const escalation = await escalatePhase(phase, issue, {
        blockedReason: phase === 'review' ? 'review_escalation' : phase === 'implement' ? 'implement_needs_input' : 'specify_needs_input',
        failureSummary: buildPhaseFailureComment(phase, issue, error),
        worktree: activeWorktree,
        pullRequest: activePullRequest,
      });
      if (escalation.kind === 'resolved') {
        applyResolvedEscalation(issue, escalation);
        return true;
      }

      await upsertIssueComment({
        repoOwner: issue.repoOwner,
        repoName: issue.repoName,
        issueNumber: issue.issueNumber,
        marker: 'workflow:phase-failure',
        body: buildPhaseFailureComment(phase, issue, error),
      });
      await waitForHumanFallback(issue, escalation.blockedReason, escalation.reviewResumeMode);
      return true;
    } catch {
      return false;
    }
  };

  workflowLoop: for (;;) {
    if (shellState.currentPhase === 'specify') {
      selectedSpecifyIssue ??= await getTopBacklogIssue(input);
      const issue = selectedSpecifyIssue;
      assertIssueMatchesExpectedRepo(issue, input);
      shellState.issueNumber = issue.issueNumber;
      shellState.issueTitle = issue.issueTitle;
      recordActivity(`Selected Backlog issue #${issue.issueNumber} for Specify.`);

      let specifyResult;
      try {
        specifyResult = await runSpecifyPhase(
          {
            issue,
            agents: input.agents,
            branchPrefix: input.branchPrefix,
            deferBlockedStatus: true,
            projectExtensionManifest,
            onProgress: recordActivity,
          },
          {
            createWorktreeForIssueIfNeeded,
            listIssueComments,
            readOpenSpecChangeFiles,
            writeOpenSpecChangeFiles,
            validateOpenSpecChange,
            loadProjectExtensionManifest: async ({ worktree }) => ensureProjectExtensionManifest(worktree),
            runAgentSequence: (agentInput) => getRunAgentSequenceActivityWithRetry(agentInput.steps, ['AgentContractError'])(agentInput),
            commitAndPush,
            openPullRequest,
            upsertIssueComment,
            moveProjectItemStatus,
          },
        );
      } catch (error) {
        if (await attemptEscalationAfterPhaseFailure('specify', issue, error)) {
          continue workflowLoop;
        }
        await preserveOriginalPhaseFailure('specify', issue, error);
        throw error;
      }

      activeWorktree = specifyResult.worktree;
      projectExtensionManifest = specifyResult.projectExtensionManifest;
      if (specifyResult.outcome === 'needs_input') {
        const escalation = await escalatePhase('specify', issue, {
          blockedReason: 'specify_needs_input',
          failureSummary: specifyResult.summaryCommentBody,
          worktree: specifyResult.worktree,
        });
        if (escalation.kind === 'resolved') {
          applyResolvedEscalation(issue, escalation);
        } else {
          await waitForHumanFallback(issue, escalation.blockedReason, escalation.reviewResumeMode);
        }
        continue workflowLoop;
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
        continue workflowLoop;
      }

      pendingSpecReviewed = false;
      selectedImplementIssue = issue;
      selectedSpecifyIssue = undefined;
      shellState.blockedReason = null;
      shellState.currentPhase = 'implement';
      recordActivity('Spec review approved; entering implement phase.');
      continue workflowLoop;
    }

    if (shellState.currentPhase === 'implement') {
      selectedImplementIssue ??= await getTopReadyIssue(input);
      const issue = selectedImplementIssue;
      assertIssueMatchesExpectedRepo(issue, input);
      shellState.issueNumber = issue.issueNumber;
      shellState.issueTitle = issue.issueTitle;
      recordActivity(`Selected Ready issue #${issue.issueNumber} for Implement.`);

      let implementResult;
      try {
        implementResult = await runImplementPhase(
          {
            issue,
            agents: input.agents,
            branchPrefix: input.branchPrefix,
            deferBlockedStatus: true,
            projectExtensionManifest,
            onProgress: recordActivity,
          },
          {
            createWorktreeForIssueIfNeeded,
            listIssueComments,
            listOpenPullRequestFeedback,
            readOpenSpecChangeFiles,
            loadProjectExtensionManifest: async ({ worktree }) => ensureProjectExtensionManifest(worktree),
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
        if (await attemptEscalationAfterPhaseFailure('implement', issue, error)) {
          continue workflowLoop;
        }
        await preserveOriginalPhaseFailure('implement', issue, error);
        throw error;
      }

      activeWorktree = implementResult.worktree;
      projectExtensionManifest = implementResult.projectExtensionManifest;
      if (implementResult.outcome === 'needs_input') {
        const escalation = await escalatePhase('implement', issue, {
          blockedReason: 'implement_needs_input',
          failureSummary: implementResult.summaryCommentBody,
          worktree: implementResult.worktree,
          pullRequest: activePullRequest,
        });
        if (escalation.kind === 'resolved') {
          applyResolvedEscalation(issue, escalation);
        } else {
          await waitForHumanFallback(issue, escalation.blockedReason, escalation.reviewResumeMode);
        }
        continue workflowLoop;
      }

      if (!implementResult.pullRequest) {
        throw new Error('Implement phase did not return a pull request.');
      }

      activePullRequest = implementResult.pullRequest;
      shellState.blockedReason = null;
      shellState.currentPhase = 'review';
      recordActivity(`Opened PR #${implementResult.pullRequest.pullRequestNumber} and moved the issue to In review.`);
      continue workflowLoop;
    }

    if (shellState.currentPhase === 'review') {
      const issue = selectedImplementIssue;
      if (!issue) {
        throw new Error('Review phase cannot start without an Implement-selected issue.');
      }
      if (!activeWorktree || !activePullRequest) {
        throw new Error('Review phase cannot start without an active worktree and pull request.');
      }

      shellState.issueNumber = issue.issueNumber;
      shellState.issueTitle = issue.issueTitle;

      let reviewResult;
      try {
        reviewResult = await runReviewPhase(
          {
            issue,
            worktree: activeWorktree,
            pullRequest: activePullRequest,
            agents: input.agents,
            projectExtensionManifest,
            reviewIteration: shellState.reviewIteration,
            deferEscalatedStatus: true,
            onProgress: recordActivity,
          },
          {
            readOpenSpecChangeFiles,
            getPullRequestDetails,
            getPullRequestDiff,
            listPullRequestFiles,
            listPullRequestReviewComments,
            loadProjectExtensionManifest: async ({ worktree }) => ensureProjectExtensionManifest(worktree),
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
        if (await attemptEscalationAfterPhaseFailure('review', issue, error)) {
          continue workflowLoop;
        }
        await preserveOriginalPhaseFailure('review', issue, error);
        throw error;
      }

      projectExtensionManifest = reviewResult.projectExtensionManifest;
      if (reviewResult.outcome === 'needs_fix') {
        shellState.reviewIteration += 1;
        shellState.currentPhase = 'implement';
        recordActivity(`Review requested fixes for PR #${activePullRequest.pullRequestNumber}; rerunning Implement for review iteration ${shellState.reviewIteration + 1}.`);
        continue workflowLoop;
      }

      if (reviewResult.outcome === 'escalated') {
        const escalation = await escalatePhase('review', issue, {
          blockedReason: 'review_escalation',
          failureSummary: reviewResult.summaryCommentBody,
          worktree: activeWorktree,
          pullRequest: activePullRequest,
        });
        if (escalation.kind === 'resolved') {
          applyResolvedEscalation(issue, escalation);
        } else {
          await waitForHumanFallback(issue, escalation.blockedReason, escalation.reviewResumeMode);
        }
        continue workflowLoop;
      }

      recordActivity(`Review approved PR #${activePullRequest.pullRequestNumber}; issue moved to Ready to merge.`);
      const result = buildAutomateReadyIssueResult(issue, activePullRequest, issue.readyToMergeStatusName);
      await cleanupSuccessfulWorktree(activeWorktree);
      return result;
    }

    throw new Error(`Workflow exited unexpectedly while in ${shellState.currentPhase}.`);
  }
}

function resolveHumanFallback(
  originPhase: WorkflowPhase,
  recommendedStatus: 'Backlog' | 'Ready' | 'In review' | undefined,
): { blockedReason: WorkflowBlockedReason; reviewResumeMode?: ReviewResumeMode; nextPhase: WorkflowPhase } {
  if (recommendedStatus === 'Backlog') {
    return {
      blockedReason: originPhase === 'specify' ? 'specify_needs_input' : 'implement_needs_input',
      nextPhase: 'specify',
    };
  }

  if (recommendedStatus === 'In review') {
    return {
      blockedReason: 'review_escalation',
      reviewResumeMode: 'review-only',
      nextPhase: 'review',
    };
  }

  return {
    blockedReason: originPhase === 'review' ? 'review_escalation' : 'implement_needs_input',
    reviewResumeMode: originPhase === 'review' ? 'implement' : undefined,
    nextPhase: originPhase === 'review' ? 'review' : 'implement',
  };
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
    `- Escalation attempts: ${state.escalationAttemptCount ?? 0}${state.escalationOriginPhase ? ` (origin: ${state.escalationOriginPhase})` : ''}`,
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
    escalationAttemptCount: 0,
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
