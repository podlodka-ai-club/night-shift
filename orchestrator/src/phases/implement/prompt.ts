import { isNightShiftMarkerComment } from '../../comment-markers';
import type { IssueComment, OpenSpecChangeFile, SelectedProjectIssue } from '../../shared';

export interface ImplementRetryFeedback {
  attempt: number;
  failure: string;
}

export interface BuildImplementPromptInput {
  issue: SelectedProjectIssue;
  changeName: string;
  specBundleFiles: readonly OpenSpecChangeFile[];
  issueComments: readonly IssueComment[];
  retryFeedback?: ImplementRetryFeedback;
}

export function buildImplementPrompt(input: BuildImplementPromptInput): string {
  return [
    'You are implementing the approved spec bundle for the linked issue.',
    '',
    `Issue #${input.issue.issueNumber}: ${input.issue.issueTitle}`,
    `URL: ${input.issue.issueUrl}`,
    '',
    'Description:',
    input.issue.taskDescription,
    '',
    `Approved spec bundle: openspec/changes/${input.changeName}`,
    renderSpecBundleFiles(input.specBundleFiles),
    '',
    'Recent operator comments:',
    renderIssueComments(input.issueComments),
    '',
    renderRetryFeedback(input.retryFeedback),
    '',
    'Return only structured output with filesWritten, commitMessage, summary, and followUps.',
  ].join('\n');
}

function renderSpecBundleFiles(specBundleFiles: readonly OpenSpecChangeFile[]): string {
  return specBundleFiles.length === 0
    ? '- (none)'
    : specBundleFiles.map((file) => `- ${file.path}\n${file.content.trim()}`).join('\n');
}

function renderIssueComments(issueComments: readonly IssueComment[]): string {
  const visibleComments = issueComments.filter((comment) => !isNightShiftMarkerComment(comment.body));
  return visibleComments.length === 0
    ? '- (none)'
    : visibleComments.map((comment, index) => `- Comment ${index + 1}:\n${comment.body.trim()}`).join('\n');
}

function renderRetryFeedback(retryFeedback: ImplementRetryFeedback | undefined): string {
  if (!retryFeedback) {
    return 'Retry feedback:\n(none)';
  }
  return `Retry feedback:\nPrevious attempt #${retryFeedback.attempt} failed with: ${retryFeedback.failure}\nPlease address this before resubmitting.`;
}