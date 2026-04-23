import * as fs from 'fs';
import { RunStage, RunState } from './types.js';
import type { RunInspector } from './store/RunInspector.js';
import type { RepoWorkspace } from './workspace/RepoWorkspace.js';

/** Minimal PR reference returned by GitHubAdapter.findOpenPRByHead. */
export interface PRRef { number: number; url: string }

/** Callback used by resolveResumeState to look up an existing open PR. */
export type FindPR = (head: string) => Promise<PRRef | null>;

export interface ResumeEvidence {
  blockedAtStage?: RunStage;
  specComplete: boolean;
  workspaceRecoverable: boolean;
  implementAttemptFailed: boolean;
  hasImplementationArtifacts: boolean;
  worktreeHasChanges: boolean;
  validationPassed: boolean;
  prExists: boolean;
}

const STAGE_RANK: Record<RunStage, number> = {
  claimed: 0,
  specified: 1,
  implemented: 2,
  validated: 3,
  pr_opened: 4,
  reviewed: 5,
  fixed: 6,
  completed: 7,
  blocked: -1,
};

function maxStage(left: RunStage, right: RunStage): RunStage {
  return STAGE_RANK[left] >= STAGE_RANK[right] ? left : right;
}

export function deriveResumeStage(evidence: ResumeEvidence): RunStage {
  let stage = evidence.blockedAtStage ?? 'claimed';
  const hasImplementationEvidence =
    !evidence.implementAttemptFailed &&
    (evidence.hasImplementationArtifacts || evidence.worktreeHasChanges);

  if (stage === 'blocked' || stage === 'completed') {
    stage = 'claimed';
  }

  if (!evidence.workspaceRecoverable && STAGE_RANK[stage] > STAGE_RANK.specified) {
    stage = evidence.specComplete ? 'specified' : 'claimed';
  }

  if (evidence.implementAttemptFailed && STAGE_RANK[stage] > STAGE_RANK.specified) {
    stage = evidence.specComplete ? 'specified' : 'claimed';
  }

  if (!hasImplementationEvidence && STAGE_RANK[stage] > STAGE_RANK.specified) {
    stage = evidence.specComplete ? 'specified' : 'claimed';
  }

  if (!evidence.validationPassed && STAGE_RANK[stage] > STAGE_RANK.implemented) {
    stage = 'implemented';
  }

  if (!evidence.prExists && STAGE_RANK[stage] > STAGE_RANK.validated) {
    stage = 'validated';
  }

  if (evidence.specComplete) {
    stage = maxStage(stage, 'specified');
  }

  if (evidence.workspaceRecoverable) {
    if (hasImplementationEvidence) {
      stage = maxStage(stage, 'implemented');

      if (evidence.validationPassed) {
        stage = maxStage(stage, 'validated');
      }
      if (evidence.prExists && STAGE_RANK[stage] < STAGE_RANK.reviewed) {
        stage = maxStage(stage, 'pr_opened');
      }
    }
  }

  return stage;
}

export function projectStatusForStage(
  stage: RunStage,
  statusValues: { inProgress: string; inReview: string },
): string {
  switch (stage) {
    case 'pr_opened':
    case 'reviewed':
    case 'fixed':
      return statusValues.inReview;
    default:
      return statusValues.inProgress;
  }
}

/**
 * Gathers evidence from disk artifacts and derives the correct resume stage.
 *
 * This combines `RunInspector` evidence-gathering with `deriveResumeStage`
 * logic so the Worker doesn't need to know the details.
 */
export async function resolveResumeState(
  prev: RunState,
  defaultBranch: string,
  inspector: RunInspector,
  workspace: RepoWorkspace,
  findPR: FindPR,
): Promise<Pick<RunState, 'stage' | 'prNumber' | 'prUrl'>> {
  const existingPr = prev.branch ? await findPR(prev.branch) : null;
  const worktreeHasUncommittedChanges = await inspector.worktreeHasUncommittedChanges(prev.worktreeDir);
  const implementAttemptFailed = inspector.latestImplementAttemptFailed(prev.ticketId);
  const workspaceRecoverable = Boolean(
    (prev.worktreeDir && fs.existsSync(prev.worktreeDir)) ||
    (prev.branch && await workspace.branchExists(prev.branch))
  );
  const stage = deriveResumeStage({
    blockedAtStage: prev.blockedAtStage,
    specComplete: Boolean(prev.openspecChangeDir && inspector.isSpecComplete(prev.openspecChangeDir)),
    workspaceRecoverable,
    implementAttemptFailed,
    hasImplementationArtifacts: inspector.hasImplementationArtifacts(prev.ticketId),
    worktreeHasChanges: implementAttemptFailed
      ? false
      : worktreeHasUncommittedChanges || await inspector.worktreeHasChanges(prev.worktreeDir, defaultBranch),
    validationPassed: !worktreeHasUncommittedChanges && inspector.hasPassingValidation(prev.ticketId),
    prExists: Boolean(existingPr ?? prev.prNumber),
  });
  const keepPrRefs = stage === 'pr_opened' || stage === 'reviewed' || stage === 'fixed';

  return {
    stage,
    prNumber: keepPrRefs ? existingPr?.number ?? prev.prNumber : undefined,
    prUrl: keepPrRefs ? existingPr?.url ?? prev.prUrl : undefined,
  };
}