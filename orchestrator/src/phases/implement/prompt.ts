import { isNightShiftMarkerComment } from '../../comment-markers';
import type { IssueComment, OpenPullRequestFeedback, OpenSpecChangeFile, SelectedProjectIssue } from '../../shared';
import { buildPromptHardeningPreamble, wrapUntrustedInput } from '../prompt-hardening';

export const IMPLEMENT_SYSTEM_PROMPT = buildPromptHardeningPreamble('You are implementing the approved spec bundle for the linked issue.');

export interface ImplementRetryFeedback {
  attempt: number;
  failure: string;
}

export interface BuildImplementPromptInput {
  issue: SelectedProjectIssue;
  changeName: string;
  specBundleFiles: readonly OpenSpecChangeFile[];
  issueComments: readonly IssueComment[];
  pullRequestFeedback?: OpenPullRequestFeedback;
  retryFeedback?: ImplementRetryFeedback;
}

export function buildImplementPrompt(input: BuildImplementPromptInput): string {
  return [
    'Issue:',
    wrapUntrustedInput('issue', renderIssue(input.issue)),
    '',
    `Approved spec bundle: openspec/changes/${input.changeName}`,
    renderSpecBundleFiles(input.specBundleFiles),
    '',
    'Recent operator comments:',
    renderIssueComments(input.issueComments),
    '',
    'Existing pull request feedback:',
    renderPullRequestFeedback(input.pullRequestFeedback),
    '',
    renderRetryFeedback(input.retryFeedback),
    '',
    'Return only structured output with filesWritten, commitMessage, summary, and followUps.',
  ].join('\n');
}

function renderIssue(issue: SelectedProjectIssue): string {
  return [`Issue #${issue.issueNumber}: ${issue.issueTitle}`, `URL: ${issue.issueUrl}`, '', 'Description:', issue.taskDescription].join('\n');
}

function renderSpecBundleFiles(specBundleFiles: readonly OpenSpecChangeFile[]): string {
  return specBundleFiles.length === 0
    ? '- (none)'
    : wrapUntrustedInput('spec-bundle-files', specBundleFiles.map((file) => `- ${file.path}\n${file.content.trim()}`).join('\n'));
}

function renderIssueComments(issueComments: readonly IssueComment[]): string {
  const visibleComments = issueComments.filter((comment) => !isNightShiftMarkerComment(comment.body));
  return visibleComments.length === 0
    ? '- (none)'
    : wrapUntrustedInput('operator-comments', visibleComments.map((comment, index) => `- Comment ${index + 1}:\n${comment.body.trim()}`).join('\n'));
}

function renderPullRequestFeedback(pullRequestFeedback: OpenPullRequestFeedback | undefined): string {
  const reviewBodies = pullRequestFeedback?.reviewBodies
    .map(normalizeFeedbackBody)
    .filter((body) => body.length > 0)
    ?? [];
  const reviewComments = pullRequestFeedback?.reviewComments
    .map((comment, index) => {
      const body = normalizeFeedbackBody(comment.body);
      if (!body) return undefined;
      const location = `${comment.path}${comment.line ? `:${comment.line}` : ''}`;
      return `- Inline comment ${index + 1} (${location}):\n${body}`;
    })
    .filter((comment): comment is string => Boolean(comment))
    ?? [];
  const reviewEntries = reviewBodies.map((body, index) => `- Review ${index + 1}:\n${body}`);
  const entries = [...reviewEntries, ...reviewComments];
  return entries.length === 0 ? '- (none)' : wrapUntrustedInput('pull-request-feedback', entries.join('\n'));
}

function normalizeFeedbackBody(body: string): string {
  return body.replace(/^<!-- night-shift:[^>]+ -->\s*\n?/, '').trim();
}

function renderRetryFeedback(retryFeedback: ImplementRetryFeedback | undefined): string {
  if (!retryFeedback) {
    return 'Retry feedback:\n(none)';
  }
  return `Retry feedback:\n${wrapUntrustedInput('retry-feedback', `Previous attempt #${retryFeedback.attempt} failed with: ${retryFeedback.failure}\nPlease address this before resubmitting.`)}`;
}
