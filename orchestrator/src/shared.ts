export const TASK_QUEUE = 'orchestrator';
export const CANONICAL_PROJECT_STATUS_NAMES = [
  'Backlog',
  'Refinement',
  'Refined',
  'Ready',
  'In progress',
  'In review',
  'Ready to merge',
  'Escalated',
  'Blocked',
] as const;
export type ProjectStatusName = (typeof CANONICAL_PROJECT_STATUS_NAMES)[number];

export const DEFAULT_READY_STATUS = 'Ready';
export const DEFAULT_IN_PROGRESS_STATUS = 'In progress';
export const DEFAULT_IN_REVIEW_STATUS = 'In review';
export const DEFAULT_READY_TO_MERGE_STATUS = 'Ready to merge';
export const DEFAULT_ESCALATED_STATUS = 'Escalated';
export const DEFAULT_BLOCKED_STATUS = 'Blocked';
export const DEFAULT_BACKLOG_STATUS = 'Backlog';
export const DEFAULT_REFINEMENT_STATUS = 'Refinement';
export const DEFAULT_REFINED_STATUS = 'Refined';
export const DEFAULT_BRANCH_PREFIX = 'orchestrator';

export const READY_ISSUE_STATUS_SEQUENCE = [
  DEFAULT_READY_STATUS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_TO_MERGE_STATUS,
] as const;

export const WORKFLOW_BLOCKED_REASONS = [
  'specify_needs_input',
  'awaiting_spec_review',
  'implement_needs_input',
  'review_escalation',
] as const;
export type WorkflowBlockedReason = (typeof WORKFLOW_BLOCKED_REASONS)[number];

export const WORKFLOW_SIGNAL_NAMES = ['specifyRetry', 'specReviewed', 'implementRetry', 'resume', 'resumeReviewOnly'] as const;
export type WorkflowSignalName = (typeof WORKFLOW_SIGNAL_NAMES)[number];
export const WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME = 'activityProgress';

export const WORKFLOW_PHASES = ['specify', 'implement', 'review'] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const BLOCKED_REASON_BOARD_SIGNAL_RULES = [
  { blockedReason: 'specify_needs_input', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
  { blockedReason: 'awaiting_spec_review', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
  { blockedReason: 'awaiting_spec_review', boardStatusName: 'Ready', signalName: 'specReviewed' },
  { blockedReason: 'implement_needs_input', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
  { blockedReason: 'implement_needs_input', boardStatusName: 'Ready', signalName: 'implementRetry' },
  { blockedReason: 'review_escalation', boardStatusName: 'Ready', signalName: 'resume' },
  { blockedReason: 'review_escalation', boardStatusName: 'In review', signalName: 'resumeReviewOnly' },
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
  escalatedStatusName?: string;
  blockedStatusName?: string;
  branchPrefix?: string;
}

export interface ListProjectIssuesByStatusInput extends AutomateReadyIssueInput {
  statusNames: ProjectStatusName[];
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
  readyToMergeOptionId: string;
  escalatedOptionId: string;
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
  readyToMergeStatusName: string;
  escalatedStatusName: string;
}

export interface ListedProjectIssue extends SelectedProjectIssue {
  currentStatusName: ProjectStatusName;
  createdAt: string;
}

export interface CreateWorktreeForIssueIfNeededInput {
  issue: SelectedProjectIssue;
  branchPrefix?: string;
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
export type AgentSchemaId = 'change-metadata-v1' | 'specify-response-v1' | 'implement-response-v1' | 'reviewer-response-v1' | 'escalation-response-v1';

export const SPECIFY_RESPONSE_OUTPUT_KEY = 'specifyResponse';
export const IMPLEMENT_RESPONSE_OUTPUT_KEY = 'implementResponse';
export const REVIEWER_RESPONSE_OUTPUT_KEY = 'reviewerResponse';
export const ESCALATION_RESPONSE_OUTPUT_KEY = 'escalationResponse';
export const CHANGE_METADATA_OUTPUT_KEY = 'changeMetadata';
export const AGENT_OUTPUT_KEYS = [
  SPECIFY_RESPONSE_OUTPUT_KEY,
  IMPLEMENT_RESPONSE_OUTPUT_KEY,
  REVIEWER_RESPONSE_OUTPUT_KEY,
  ESCALATION_RESPONSE_OUTPUT_KEY,
  CHANGE_METADATA_OUTPUT_KEY,
] as const;

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

export const AGENT_PROFILE_NAMES = ['default', 'escalation'] as const;
export type AgentProfileName = (typeof AGENT_PROFILE_NAMES)[number];

export interface RunAgentLegacyInput {
  worktree: WorktreeContext;
  agentProfile?: AgentProfileName;
}

export interface RunAgentSequenceInput {
  worktree: WorktreeContext;
  steps: [AgentStep, ...AgentStep[]];
  agentProfile?: AgentProfileName;
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
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface PullRequestDetails {
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  isDraft: boolean;
}

export interface PullRequestChangedFile {
  path: string;
  patch?: string;
}

export interface PullRequestReviewComment {
  id: number;
  body: string;
  path: string;
  line?: number;
}

export interface OpenPullRequestFeedback {
  reviewBodies: string[];
  reviewComments: PullRequestReviewComment[];
}

export interface ListOpenPullRequestFeedbackInput {
  worktree: WorktreeContext;
}

export interface GetPullRequestDetailsInput {
  repoOwner: string;
  repoName: string;
  pullRequestNumber: number;
}

export type PullRequestReviewContextInput = GetPullRequestDetailsInput;

export interface SetPullRequestReadyInput extends GetPullRequestDetailsInput {
  ready: boolean;
}

export type PullRequestReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface CreatePullRequestReviewInput extends GetPullRequestDetailsInput {
  event: PullRequestReviewEvent;
  body: string;
}

export interface UpsertPullRequestReviewCommentInput extends GetPullRequestDetailsInput {
  commitId: string;
  marker: string;
  body: string;
  path: string;
  line: number;
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

export interface AddIssueLabelsInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  labels: string[];
}

export interface OpenSpecChangeFile {
  path: string;
  content: string;
}

export interface RepositoryFile {
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

export interface WriteRepositoryFilesInput {
  worktree: WorktreeContext;
  files: RepositoryFile[];
}

export interface RunQualityGateInput {
  worktree: WorktreeContext;
}

export interface QualityGateResult {
  passed: boolean;
  summary: string;
  logs: string;
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
  targetStatusName: string;
}