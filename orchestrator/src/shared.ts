export const TASK_QUEUE = 'orchestrator';
export const DEFAULT_READY_STATUS = 'Ready';
export const DEFAULT_IN_PROGRESS_STATUS = 'In progress';
export const DEFAULT_IN_REVIEW_STATUS = 'In review';
export const DEFAULT_BLOCKED_STATUS = 'Blocked';
export const DEFAULT_BRANCH_PREFIX = 'orchestrator';
export const DEFAULT_FILE_PATH_PREFIX = 'orchestrator-runs';

export interface AutomateReadyIssueInput {
  projectOwner: string;
  projectNumber: number;
  readyStatusName?: string;
  inReviewStatusName?: string;
  blockedStatusName?: string;
  branchPrefix?: string;
  filePathPrefix?: string;
}

export interface SelectedProjectIssue {
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
  readyOptionId: string;
  inProgressOptionId: string;
  inReviewOptionId: string;
  blockedOptionId?: string;
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

export interface AgentPromptStep {
  id: string;
  kind: 'prompt';
  prompt: string;
}

export interface AgentStructuredStep {
  id: string;
  kind: 'structured';
  prompt: string;
  schemaId: AgentSchemaId;
  resultKey: AgentOutputKey;
}

export type AgentStep = AgentPromptStep | AgentStructuredStep;
export type AgentSchemaId = 'change-metadata-v1';

export const CHANGE_METADATA_OUTPUT_KEY = 'changeMetadata';
export const AGENT_OUTPUT_KEYS = [CHANGE_METADATA_OUTPUT_KEY] as const;

export type AgentOutputKey = (typeof AGENT_OUTPUT_KEYS)[number];

export interface AgentSequenceResult {
  threadId: string;
  completedStepIds: string[];
  outputs: Partial<Record<AgentOutputKey, unknown>>;
  finalResponse?: string;
}

export interface ChangeMetadata {
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface RunAgentLegacyInput {
  worktree: WorktreeContext;
}

export interface RunAgentSequenceInput {
  worktree: WorktreeContext;
  steps: [AgentStep, ...AgentStep[]];
}

export interface CommitAndPushInput {
  worktree: WorktreeContext;
  commitMessage?: string;
}

export interface OpenPullRequestInput {
  worktree: WorktreeContext;
  title?: string;
  body?: string;
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