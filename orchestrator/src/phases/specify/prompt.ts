import { isNightShiftMarkerComment } from '../../comment-markers';
import type { IssueComment, OpenSpecChangeFile, SelectedProjectIssue } from '../../shared';
import { buildChangeName } from '../change-name';

export interface BuildSpecifyPromptInput {
  issue: SelectedProjectIssue;
  changeName: string;
  issueComments: readonly IssueComment[];
  currentDraftFiles: readonly OpenSpecChangeFile[];
  validationError?: string;
}

export function buildSpecifyPrompt(input: BuildSpecifyPromptInput): string {
  return [
    'You are drafting an OpenSpec proposal for the linked issue.',
    '',
    `Issue #${input.issue.issueNumber}: ${input.issue.issueTitle}`,
    input.issue.taskDescription,
    '',
    `Change folder: openspec/changes/${input.changeName}`,
    '',
    'Return only structured output with proposal.md, tasks.md, and any needed specs/<capability>/spec.md files.',
    'Use openQuestions for anything that still requires operator input.',
    input.validationError ? `Previous validation error:\n${input.validationError}` : 'Previous validation error:\n(none)',
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

function renderIssueComments(issueComments: readonly IssueComment[]): string {
  const visibleComments = issueComments.filter((comment) => !isNightShiftMarkerComment(comment.body));
  if (visibleComments.length === 0) {
    return '- (none)';
  }

  return visibleComments.map((comment, index) => `- Comment ${index + 1}:\n${comment.body.trim()}`).join('\n');
}

function renderDraftFiles(currentDraftFiles: readonly OpenSpecChangeFile[]): string {
  if (currentDraftFiles.length === 0) {
    return '- (none)';
  }

  return currentDraftFiles.map((file) => `- ${file.path}\n${file.content.trim()}`).join('\n');
}
