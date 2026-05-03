import { isNightShiftMarkerComment } from '../../comment-markers';
import type { IssueComment, OpenSpecChangeFile, SelectedProjectIssue } from '../../shared';
import { buildChangeName } from '../change-name';
import { buildPromptHardeningPreamble, wrapUntrustedInput } from '../prompt-hardening';

export const SPECIFY_SYSTEM_PROMPT = buildPromptHardeningPreamble('You are drafting an OpenSpec proposal for the linked issue.');

export interface BuildSpecifyPromptInput {
  issue: SelectedProjectIssue;
  changeName: string;
  issueComments: readonly IssueComment[];
  currentDraftFiles: readonly OpenSpecChangeFile[];
  validationError?: string;
}

export function buildSpecifyPrompt(input: BuildSpecifyPromptInput): string {
  return [
    'Issue:',
    wrapUntrustedInput('issue', renderIssue(input.issue)),
    '',
    `Change folder: openspec/changes/${input.changeName}`,
    '',
    'Return only structured output with proposal.md, tasks.md, and any needed specs/<capability>/spec.md files.',
    'Use openQuestions for anything that still requires operator input.',
    'Previous validation error:',
    input.validationError ? wrapUntrustedInput('validation-error', input.validationError) : '(none)',
    '',
    'Recent operator comments:',
    renderIssueComments(input.issueComments),
    '',
    'Current draft files:',
    renderDraftFiles(input.currentDraftFiles),
  ].join('\n');
}

export function buildSpecifyChangeName(issue: SelectedProjectIssue): string {
  return buildChangeName(issue);
}

function renderIssue(issue: SelectedProjectIssue): string {
  return [`Issue #${issue.issueNumber}: ${issue.issueTitle}`, '', issue.taskDescription].join('\n');
}

function renderIssueComments(issueComments: readonly IssueComment[]): string {
  const visibleComments = issueComments.filter((comment) => !isNightShiftMarkerComment(comment.body));
  if (visibleComments.length === 0) {
    return '- (none)';
  }

  return wrapUntrustedInput(
    'operator-comments',
    visibleComments.map((comment, index) => `- Comment ${index + 1}:\n${comment.body.trim()}`).join('\n'),
  );
}

function renderDraftFiles(currentDraftFiles: readonly OpenSpecChangeFile[]): string {
  if (currentDraftFiles.length === 0) {
    return '- (none)';
  }

  return wrapUntrustedInput(
    'current-draft-files',
    currentDraftFiles.map((file) => `- ${file.path}\n${file.content.trim()}`).join('\n'),
  );
}
