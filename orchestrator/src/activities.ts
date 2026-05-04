import { createAgentActivities } from './activity-agent-sequence';
import { createActivityDependencies, type ActivityRuntimes, type CreateActivityDependenciesOptions } from './activity-deps';
import { createGitHubActivities } from './activity-github';
import { createProjectExtensionActivities } from './project-extension';
import { createWorktreeActivities } from './activity-worktree';

export { createActivityDependencies } from './activity-deps';
export { buildIssueComment } from './activity-github';
export { buildBranchName } from './activity-worktree';

export function createActivityRuntimes(options: CreateActivityDependenciesOptions = {}): ActivityRuntimes {
  const deps = createActivityDependencies(options);
  return {
    github: deps,
    worktree: deps,
    agent: deps,
  };
}

export function createActivities(runtimes: ActivityRuntimes) {
  return {
    ...createGitHubActivities(runtimes.github),
    ...createWorktreeActivities(runtimes.worktree),
    ...createAgentActivities(runtimes.agent),
    ...createProjectExtensionActivities(),
  };
}

export type Activities = ReturnType<typeof createActivities>;

const defaultActivities = createActivities(createActivityRuntimes());

export const {
  ensureProjectStatusOptions,
  getTopBacklogIssue,
  getTopReadyIssue,
  // Client-side intake uses this activity directly; workflows intentionally keep selection inside
  // their existing phase-specific `getTopBacklogIssue` / `getTopReadyIssue` activity boundaries.
  listProjectIssuesByStatus,
  openPullRequest,
  addIssueLabels,
  listIssueComments,
  getPullRequestDetails,
  getPullRequestDiff,
  listOpenPullRequestFeedback,
  listPullRequestFiles,
  listPullRequestReviewComments,
  setPullRequestReady,
  createPullRequestReview,
  upsertPullRequestReviewComment,
  commentOnIssue,
  upsertIssueComment,
  moveProjectItemStatus,
  createWorktreeForIssueIfNeeded,
  readOpenSpecChangeFiles,
  writeOpenSpecChangeFiles,
  validateOpenSpecChange,
  writeRepositoryFiles,
  runQualityGate,
  loadProjectExtensionManifest,
  commitAndPush,
  cleanupWorktree,
  runAgentLegacy,
  runAgentSequence,
} = defaultActivities;
