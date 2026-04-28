export const TASK_QUEUE = 'orchestrator';
export const CANONICAL_PROJECT_STATUS_NAMES = [
  'Backlog',
  'Refinement',
  'Refined',
  'Ready',
  'In progress',
  'In review',
  'Ready to merge',
  'Blocked',
] as const;
export type ProjectStatusName = (typeof CANONICAL_PROJECT_STATUS_NAMES)[number];

export const DEFAULT_READY_STATUS = 'Ready';
export const DEFAULT_IN_PROGRESS_STATUS = 'In progress';
export const DEFAULT_IN_REVIEW_STATUS = 'In review';
export const DEFAULT_BLOCKED_STATUS = 'Blocked';
export const DEFAULT_BACKLOG_STATUS = 'Backlog';
export const DEFAULT_REFINEMENT_STATUS = 'Refinement';
export const DEFAULT_REFINED_STATUS = 'Refined';
export const DEFAULT_BRANCH_PREFIX = 'orchestrator';
export const DEFAULT_FILE_PATH_PREFIX = 'orchestrator-runs';

export const READY_ISSUE_STATUS_SEQUENCE = [
  DEFAULT_READY_STATUS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
] as const;

export const WORKFLOW_BLOCKED_REASONS = [
  'specify_needs_input',
  'awaiting_spec_review',
  'implement_needs_input',
  'review_escalation',
] as const;
export type WorkflowBlockedReason = (typeof WORKFLOW_BLOCKED_REASONS)[number];

export const WORKFLOW_SIGNAL_NAMES = ['specifyRetry', 'specReviewed', 'implementRetry', 'resume'] as const;
export type WorkflowSignalName = (typeof WORKFLOW_SIGNAL_NAMES)[number];
export const WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME = 'activityProgress';

export const WORKFLOW_PHASES = ['specify', 'implement', 'review'] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const BLOCKED_REASON_BOARD_SIGNAL_RULES = [
  { blockedReason: 'specify_needs_input', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
  { blockedReason: 'awaiting_spec_review', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
  { blockedReason: 'awaiting_spec_review', boardStatusName: 'Ready', signalName: 'specReviewed' },
  { blockedReason: 'implement_needs_input', boardStatusName: 'Ready', signalName: 'implementRetry' },
  { blockedReason: 'review_escalation', boardStatusName: 'Ready', signalName: 'resume' },
  { blockedReason: 'review_escalation', boardStatusName: 'In review', signalName: 'resume' },
] as const satisfies ReadonlyArray<{
  blockedReason: WorkflowBlockedReason;
  boardStatusName: ProjectStatusName;
  signalName: WorkflowSignalName;
}>;

export interface EnsureProjectStatusOptionsInput {
  projectOwner: string;
  projectNumber: number;
}

export interface ResolvedProjectStatusOptions {
  projectId: string;
  statusFieldId: string;
  statusOptionIds: Record<ProjectStatusName, string>;
}

export interface AutomateReadyIssueInput {
  projectOwner: string;
  projectNumber: number;
  startPhase?: WorkflowPhase;
  backlogStatusName?: string;
  refinementStatusName?: string;
  refinedStatusName?: string;
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
  backlogOptionId: string;
  refinementOptionId: string;
  refinedOptionId: string;
  readyOptionId: string;
  inProgressOptionId: string;
  inReviewOptionId: string;
  blockedOptionId: string;
  issueNumber: number;
  issueTitle: string;
  taskDescription: string;
  issueUrl: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  backlogStatusName: string;
  refinementStatusName: string;
  refinedStatusName: string;
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
export type AgentSchemaId = 'change-metadata-v1' | 'specify-response-v1';

export const SPECIFY_RESPONSE_OUTPUT_KEY = 'specifyResponse';
export const CHANGE_METADATA_OUTPUT_KEY = 'changeMetadata';
export const AGENT_OUTPUT_KEYS = [SPECIFY_RESPONSE_OUTPUT_KEY, CHANGE_METADATA_OUTPUT_KEY] as const;

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
  draft?: boolean;
  updateIfExists?: boolean;
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

export interface IssueComment {
  id: number;
  body: string;
}

export interface ListIssueCommentsInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
}

export interface UpsertIssueCommentInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  marker: string;
  body: string;
}

export interface OpenSpecChangeFile {
  path: string;
  content: string;
}

export interface ReadOpenSpecChangeFilesInput {
  worktree: WorktreeContext;
  changeName: string;
}

export interface WriteOpenSpecChangeFilesInput extends ReadOpenSpecChangeFilesInput {
  files: OpenSpecChangeFile[];
}

export interface ValidateOpenSpecChangeInput {
  worktree: WorktreeContext;
  changeName: string;
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