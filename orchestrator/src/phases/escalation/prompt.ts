import { isNightShiftMarkerComment } from '../../comment-markers';
import type {
  IssueComment,
  OpenSpecChangeFile,
  PullRequestChangedFile,
  PullRequestDetails,
  PullRequestReviewComment,
  SelectedProjectIssue,
  WorkflowBlockedReason,
  WorkflowPhase,
  WorktreeContext,
} from '../../shared';

const DEFAULT_MAX_DIFF_CHARACTERS = 8_000;

export interface BuildEscalationPromptInput {
  issue: SelectedProjectIssue;
  originPhase: WorkflowPhase;
  blockedReason?: WorkflowBlockedReason;
  failureSummary?: string;
  changeName: string;
  worktree: WorktreeContext;
  issueComments: readonly IssueComment[];
  specBundleFiles: readonly OpenSpecChangeFile[];
  pullRequest?: PullRequestDetails;
  diff?: string;
  changedFiles?: readonly PullRequestChangedFile[];
  reviewComments?: readonly PullRequestReviewComment[];
  validationError?: string;
  maxDiffCharacters?: number;
}

export function buildEscalationPrompt(input: BuildEscalationPromptInput): string {
  const maxDiffCharacters = input.maxDiffCharacters ?? DEFAULT_MAX_DIFF_CHARACTERS;
  return [
    'You are the Escalation Manager for the Night Shift orchestrator.',
    '',
    'Your job is to recover tickets that automation could not complete without immediately requiring a human.',
    'Operate in the same worktree and branch as the ticket workflow.',
    'Prefer small, targeted repairs that restore the normal workflow.',
    'Do not change board status, create independent branches, approve or merge PRs, or hide unresolved risk.',
    'Return JSON only matching the required schema.',
    '',
    `Issue #${input.issue.issueNumber}: ${input.issue.issueTitle}`,
    `Issue URL: ${input.issue.issueUrl}`,
    `Origin phase: ${input.originPhase}`,
    `Blocked reason: ${input.blockedReason ?? '(none recorded)'}`,
    `Change folder: openspec/changes/${input.changeName}`,
    `Worktree path: ${input.worktree.worktreePath}`,
    `Branch: ${input.worktree.branchName}`,
    '',
    '## Description',
    input.issue.taskDescription,
    '',
    '## Failure context',
    input.failureSummary ?? '(none)',
    '',
    '## Previous validation error',
    input.validationError ?? '(none)',
    '',
    '## Recent operator comments',
    renderOperatorComments(input.issueComments),
    '',
    '## Recent Night Shift summaries',
    renderNightShiftSummaries(input.issueComments),
    '',
    '## OpenSpec bundle',
    renderSpecBundle(input.specBundleFiles),
    '',
    '## Pull request context',
    renderPullRequestContext(input.pullRequest, input.diff, input.changedFiles ?? [], input.reviewComments ?? [], maxDiffCharacters),
    '',
    '## Response requirements',
    '- Return JSON only.',
    '- First identify the root cause and supporting evidence.',
    '- If a safe automated repair is available, return a resolved response with the exact file changes and validation plan.',
    '- If a product decision, missing credential, external outage, ambiguous requirement, or unsafe rewrite is involved, return needs_human.',
    '- Do not invent missing requirements.',
  ].join('\n');
}

function renderOperatorComments(issueComments: readonly IssueComment[]): string {
  const visibleComments = issueComments.filter((comment) => !isNightShiftMarkerComment(comment.body));
  if (visibleComments.length === 0) {
    return '- (none)';
  }

  return visibleComments.map((comment, index) => `- Comment ${index + 1}:\n${comment.body.trim()}`).join('\n');
}

function renderNightShiftSummaries(issueComments: readonly IssueComment[]): string {
  const markerComments = issueComments.filter((comment) => isNightShiftMarkerComment(comment.body));
  if (markerComments.length === 0) {
    return '- (none)';
  }

  return markerComments.map((comment, index) => `- Summary ${index + 1}:\n${stripNightShiftMarker(comment.body)}`).join('\n');
}

function stripNightShiftMarker(body: string): string {
  return body.replace(/^<!-- night-shift:[^>]+ -->\s*\n?/, '').trim();
}

function renderSpecBundle(files: readonly OpenSpecChangeFile[]): string {
  if (files.length === 0) {
    return '- (none)';
  }

  return files.map((file) => [`### ${file.path}`, '```md', file.content.trimEnd(), '```'].join('\n')).join('\n\n');
}

function renderPullRequestContext(
  pullRequest: PullRequestDetails | undefined,
  diff: string | undefined,
  changedFiles: readonly PullRequestChangedFile[],
  reviewComments: readonly PullRequestReviewComment[],
  maxDiffCharacters: number,
): string {
  if (!pullRequest) {
    return '- (none)';
  }

  return [
    `Pull request: ${pullRequest.pullRequestUrl}`,
    `Draft: ${pullRequest.isDraft ? 'yes' : 'no'}`,
    '',
    '### Changed files',
    ...(changedFiles.length === 0 ? ['- none'] : changedFiles.map((file) => `- ${file.path}${file.patch ? ` — ${summarizePatch(file.patch)}` : ''}`)),
    '',
    '### Existing review comments',
    ...(reviewComments.length === 0 ? ['- none'] : reviewComments.map((comment) => `- ${comment.path}${comment.line ? `:${comment.line}` : ''} — ${comment.body.replace(/\s+/g, ' ').trim()}`)),
    '',
    '### Diff',
    renderDiff(diff ?? '', changedFiles, maxDiffCharacters),
  ].join('\n');
}

function renderDiff(diff: string, changedFiles: readonly PullRequestChangedFile[], maxDiffCharacters: number): string {
  const trimmedDiff = diff.trim();
  if (trimmedDiff.length <= maxDiffCharacters) {
    return ['```diff', trimmedDiff || '(empty diff)', '```'].join('\n');
  }

  return [
    `_Diff truncated to ${maxDiffCharacters} characters. Review the changed-file summary above._`,
    '',
    '```diff',
    `${trimmedDiff.slice(0, maxDiffCharacters).trimEnd()}\n...[truncated]`,
    '```',
  ].join('\n');
}

function summarizePatch(patch: string): string {
  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;
  return `+${additions} / -${deletions}`;
}