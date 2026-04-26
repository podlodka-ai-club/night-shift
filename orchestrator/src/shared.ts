export const TASK_QUEUE = 'orchestrator';
export const DEFAULT_READY_STATUS = 'Ready';
export const DEFAULT_IN_PROGRESS_STATUS = 'In progress';
export const DEFAULT_IN_REVIEW_STATUS = 'In review';
export const DEFAULT_BRANCH_PREFIX = 'orchestrator';
export const DEFAULT_FILE_PATH_PREFIX = 'orchestrator-runs';

export interface AutomateReadyIssueInput {
  projectOwner: string;
  projectNumber: number;
  readyStatusName?: string;
  inReviewStatusName?: string;
  branchPrefix?: string;
  filePathPrefix?: string;
}

export interface SelectedProjectIssue {
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
  inProgressOptionId: string;
  inReviewOptionId: string;
  issueNumber: number;
  issueTitle: string;
  taskDescription: string;
  issueUrl: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  readyStatusName: string;
  inReviewStatusName: string;
}

export interface CreateWorktreeForIssueIfNeededInput {
  issue: SelectedProjectIssue;
  branchPrefix?: string;
  filePathPrefix?: string;
}

export interface WorktreeContext {
  issueNumber: number;
  issueTitle: string;
  taskDescription: string;
  issueUrl: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
  filePath: string;
  generatedAt: string;
  repoRoot: string;
  worktreePath: string;
}

export interface RunAgentInput {
  worktree: WorktreeContext;
}

export interface CommitAndPushInput {
  worktree: WorktreeContext;
}

export interface OpenPullRequestInput {
  worktree: WorktreeContext;
}

export interface CleanupWorktreeInput {
  worktree: WorktreeContext;
}

export interface CreatedPullRequest {
  branchName: string;
  filePath: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface IssueCommentInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  pullRequestUrl: string;
}

export interface MoveProjectItemStatusInput {
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
  statusOptionId: string;
}

export interface AutomateReadyIssueResult {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  branchName: string;
  filePath: string;
  targetStatusName: string;
}