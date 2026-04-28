import { createAgentActivities } from './activity-agent-sequence';
import { createActivityDependencies, type ActivityRuntimes } from './activity-deps';
import { createGitHubActivities } from './activity-github';
import { createWorktreeActivities } from './activity-worktree';

export { createActivityDependencies } from './activity-deps';
export { buildIssueComment } from './activity-github';
export { buildBranchName, buildDummyChangeContent, buildDummyFilePath } from './activity-worktree';

export function createActivityRuntimes(): ActivityRuntimes {
  const deps = createActivityDependencies();
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
  };
}

export type Activities = ReturnType<typeof createActivities>;

const defaultActivities = createActivities(createActivityRuntimes());

export const {
  ensureProjectStatusOptions,
  getTopBacklogIssue,
  getTopReadyIssue,
  openPullRequest,
  addIssueLabels,
  listIssueComments,
  getPullRequestDetails,
  getPullRequestDiff,
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
  commitAndPush,
  cleanupWorktree,
  runAgentLegacy,
  runAgentSequence,
  runDummyAgent,
} = defaultActivities;
