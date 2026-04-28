import type { OpenSpecChangeFile, PullRequestChangedFile, PullRequestDetails, PullRequestReviewComment, SelectedProjectIssue } from '../../shared';

const DEFAULT_MAX_DIFF_CHARACTERS = 12_000;

export interface BuildReviewPromptInput {
  issue: SelectedProjectIssue;
  changeName: string;
  pullRequest: PullRequestDetails;
  specBundleFiles: readonly OpenSpecChangeFile[];
  diff: string;
  changedFiles: readonly PullRequestChangedFile[];
  reviewComments: readonly PullRequestReviewComment[];
  maxDiffCharacters?: number;
}

export function buildReviewPrompt(input: BuildReviewPromptInput): string {
  const maxDiffCharacters = input.maxDiffCharacters ?? DEFAULT_MAX_DIFF_CHARACTERS;
  return [
    `# Review issue #${input.issue.issueNumber}: ${input.issue.issueTitle}`,
    `Issue URL: ${input.issue.issueUrl}`,
    `Change: openspec/changes/${input.changeName}`,
    `Pull request: ${input.pullRequest.pullRequestUrl}`,
    '',
    '## Description',
    input.issue.taskDescription,
    '',
    '## Spec bundle',
    renderSpecBundle(input.specBundleFiles),
    '',
    '## PR Diff',
    renderDiff(input.diff, input.changedFiles, maxDiffCharacters),
    '',
    '## Existing review comments',
    renderReviewComments(input.reviewComments),
    '',
    '## Response requirements',
    '- Return JSON only.',
    '- Use `summary` for the overall review summary.',
    '- Use `findings` for concrete issues or warnings.',
    '- Each finding severity must be `error` or `warning`.',
    '- Add `location.file` and optional `location.line` when a finding maps to a changed file.',
    '- Warnings are non-blocking; errors indicate the change is not ready to merge.',
  ].join('\n');
}

function renderSpecBundle(files: readonly OpenSpecChangeFile[]): string {
  if (files.length === 0) return '- none';
  return files.map((file) => [`### ${file.path}`, '```md', file.content.trimEnd(), '```'].join('\n')).join('\n\n');
}

function renderDiff(diff: string, changedFiles: readonly PullRequestChangedFile[], maxDiffCharacters: number): string {
  const trimmedDiff = diff.trim();
  if (trimmedDiff.length <= maxDiffCharacters) {
    return ['```diff', trimmedDiff || '(empty diff)', '```'].join('\n');
  }

  return [
    `_Diff truncated to ${maxDiffCharacters} characters. Review the changed-file summary below._`,
    '',
    '### Changed files',
    ...(changedFiles.length === 0
      ? ['- none']
      : changedFiles.map((file) => `- ${file.path}${file.patch ? ` — ${summarizePatch(file.patch)}` : ''}`)),
    '',
    '```diff',
    `${trimmedDiff.slice(0, maxDiffCharacters).trimEnd()}\n...[truncated]`,
    '```',
  ].join('\n');
}

function renderReviewComments(comments: readonly PullRequestReviewComment[]): string {
  if (comments.length === 0) return '- none';
  return comments.map((comment) => `- ${comment.path}${comment.line ? `:${comment.line}` : ''} — ${comment.body.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function summarizePatch(patch: string): string {
  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;
  return `+${additions} / -${deletions}`;
}
