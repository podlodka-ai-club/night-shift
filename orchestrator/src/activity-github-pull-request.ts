import type { GitHubActivityDeps } from './activity-deps';
import { ApplicationFailure } from '@temporalio/common';
import { buildNightShiftMarker } from './comment-markers';
import type {
  AddIssueLabelsInput,
  CreatePullRequestReviewInput,
  CreatedPullRequest,
  GetPullRequestDetailsInput,
  IssueComment,
  IssueCommentInput,
  ListOpenPullRequestFeedbackInput,
  ListIssueCommentsInput,
  OpenPullRequestFeedback,
  OpenPullRequestInput,
  PullRequestChangedFile,
  PullRequestDetails,
  PullRequestReviewComment,
  PullRequestReviewContextInput,
  SetPullRequestReadyInput,
  UpsertPullRequestReviewCommentInput,
  UpsertIssueCommentInput,
  WorktreeContext,
} from './shared';
import { GITHUB_JSON_HEADERS, buildRepoApiPath, githubGraphql, githubRest, githubRestText, isPullRequestAlreadyExistsError, isPullRequestSelfReviewError } from './activity-github-client';

interface PullRequestResponse {
  number: number;
  html_url: string;
  node_id?: string;
  draft?: boolean;
  head?: { sha?: string };
}

interface PullRequestReviewCommentResponse {
  id: number;
  body: string;
  path: string;
  line?: number | null;
  user?: { login?: string | null } | null;
  created_at?: string | null;
}

interface PullRequestReviewResponse {
  body?: string | null;
  user?: { login?: string | null } | null;
  created_at?: string | null;
}

const MARK_PULL_REQUEST_READY_MUTATION = `
  mutation MarkPullRequestReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id }
    }
  }
`;

export function buildIssueComment(pullRequestUrl: string): string {
  return `Opened a pull request for this issue: ${pullRequestUrl}`;
}

export function buildMarkerComment(marker: string, body: string): string {
  return `${buildNightShiftMarker(marker)}\n${body.trim()}`;
}

export async function openPullRequestActivity(deps: GitHubActivityDeps, input: OpenPullRequestInput): Promise<CreatedPullRequest> {
  const existingPullRequest = await findOpenPullRequestForBranch(deps, input.worktree);
  if (existingPullRequest) {
    const pullRequest = input.updateIfExists
      ? await updatePullRequest(deps, input.worktree, existingPullRequest.number, input.title, input.body)
      : existingPullRequest;
    return buildCreatedPullRequest(input.worktree, pullRequest);
  }

  return buildCreatedPullRequest(input.worktree, await createPullRequestWithDuplicateRecovery(deps, input));
}

export async function listIssueCommentsActivity(deps: GitHubActivityDeps, input: ListIssueCommentsInput): Promise<IssueComment[]> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  const comments = await githubRest<Array<{ id: number; body: string; user?: { login?: string | null } | null; created_at?: string | null }>>(deps, `${repoPath}/issues/${input.issueNumber}/comments`);
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    ...(comment.user?.login ? { authorLogin: comment.user.login } : {}),
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
  }));
}

export async function addIssueLabelsActivity(deps: GitHubActivityDeps, input: AddIssueLabelsInput): Promise<void> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  await githubRest(deps, `${repoPath}/issues/${input.issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: input.labels }),
  });
}

export async function getPullRequestDetailsActivity(
  deps: GitHubActivityDeps,
  input: GetPullRequestDetailsInput,
): Promise<PullRequestDetails> {
  const pullRequest = await getPullRequest(deps, input);
  return {
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
    headSha: pullRequest.head?.sha ?? '',
    isDraft: pullRequest.draft ?? false,
  };
}

export async function getPullRequestDiffActivity(deps: GitHubActivityDeps, input: PullRequestReviewContextInput): Promise<string> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  return githubRestText(deps, `${repoPath}/pulls/${input.pullRequestNumber}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  });
}

export async function listPullRequestFilesActivity(
  deps: GitHubActivityDeps,
  input: PullRequestReviewContextInput,
): Promise<PullRequestChangedFile[]> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  const files = await githubRest<Array<{ filename: string; patch?: string }>>(
    deps,
    `${repoPath}/pulls/${input.pullRequestNumber}/files?per_page=100`,
  );
  return files.map((file) => ({ path: file.filename, ...(file.patch ? { patch: file.patch } : {}) }));
}

export async function listPullRequestReviewCommentsActivity(
  deps: GitHubActivityDeps,
  input: PullRequestReviewContextInput,
): Promise<PullRequestReviewComment[]> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  const comments = await githubRest<PullRequestReviewCommentResponse[]>(
    deps,
    `${repoPath}/pulls/${input.pullRequestNumber}/comments?per_page=100`,
  );
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    path: comment.path,
    ...(comment.line === null || comment.line === undefined ? {} : { line: comment.line }),
    ...(comment.user?.login ? { authorLogin: comment.user.login } : {}),
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
  }));
}

export async function listOpenPullRequestFeedbackActivity(
  deps: GitHubActivityDeps,
  input: ListOpenPullRequestFeedbackInput,
): Promise<OpenPullRequestFeedback> {
  const existingPullRequest = await findOpenPullRequestForBranch(deps, input.worktree);
  if (!existingPullRequest) {
    return { reviewBodies: [], reviewComments: [] };
  }

  const reviewInput = {
    repoOwner: input.worktree.repoOwner,
    repoName: input.worktree.repoName,
    pullRequestNumber: existingPullRequest.number,
  };

  const [reviewBodies, reviewComments] = await Promise.all([
    listPullRequestReviewsActivity(deps, reviewInput),
    listPullRequestReviewCommentsActivity(deps, reviewInput),
  ]);

  return { reviewBodies, reviewComments };
}

export async function setPullRequestReadyActivity(deps: GitHubActivityDeps, input: SetPullRequestReadyInput): Promise<void> {
  if (!input.ready) {
    throw new Error('Converting a pull request back to draft is not supported in this branch.');
  }
  const pullRequest = await getPullRequest(deps, input);
  if (!pullRequest.node_id) {
    throw new Error(`Pull request #${input.pullRequestNumber} did not include a node_id.`);
  }
  if (!pullRequest.draft) {
    return;
  }
  await githubGraphql(deps, MARK_PULL_REQUEST_READY_MUTATION, { pullRequestId: pullRequest.node_id });
}

export async function createPullRequestReviewActivity(deps: GitHubActivityDeps, input: CreatePullRequestReviewInput): Promise<void> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  try {
    await githubRest(deps, `${repoPath}/pulls/${input.pullRequestNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ event: input.event, body: input.body }),
    });
  } catch (error) {
    if (isPullRequestSelfReviewError(error)) {
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : String(error),
        'GitHubSelfReviewNotAllowed',
      );
    }
    throw error;
  }
}

export async function upsertPullRequestReviewCommentActivity(
  deps: GitHubActivityDeps,
  input: UpsertPullRequestReviewCommentInput,
): Promise<void> {
  const existingComment = (await listPullRequestReviewCommentsActivity(deps, input)).find((comment) => (
    comment.path === input.path
    && comment.line === input.line
    && comment.body.includes(buildNightShiftMarker(input.marker))
  ));
  const body = buildMarkerComment(input.marker, input.body);
  if (existingComment) {
    await updatePullRequestReviewComment(deps, input.repoOwner, input.repoName, existingComment.id, body);
    return;
  }
  await createPullRequestReviewComment(deps, input, body);
}

async function listPullRequestReviewsActivity(
  deps: GitHubActivityDeps,
  input: PullRequestReviewContextInput,
): Promise<OpenPullRequestFeedback['reviewBodies']> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  const reviews = await githubRest<PullRequestReviewResponse[]>(
    deps,
    `${repoPath}/pulls/${input.pullRequestNumber}/reviews?per_page=100`,
  );
  return reviews
    .map((review) => ({
      body: review.body?.trim() ?? '',
      ...(review.user?.login ? { authorLogin: review.user.login } : {}),
      ...(review.created_at ? { createdAt: review.created_at } : {}),
    }))
    .filter((review) => review.body.length > 0);
}

export async function commentOnIssueActivity(deps: GitHubActivityDeps, input: IssueCommentInput): Promise<void> {
  await createIssueComment(deps, input.repoOwner, input.repoName, input.issueNumber, buildIssueComment(input.pullRequestUrl));
}

export async function upsertIssueCommentActivity(deps: GitHubActivityDeps, input: UpsertIssueCommentInput): Promise<void> {
  const body = buildMarkerComment(input.marker, input.body);
  if (isAppendOnlyIssueCommentMarker(input.marker)) {
    await createIssueComment(deps, input.repoOwner, input.repoName, input.issueNumber, body);
    return;
  }

  const existingComment = (await listIssueCommentsActivity(deps, input)).find((comment) => comment.body.includes(buildNightShiftMarker(input.marker)));
  if (existingComment) {
    await updateIssueComment(deps, input.repoOwner, input.repoName, existingComment.id, body);
    return;
  }
  await createIssueComment(deps, input.repoOwner, input.repoName, input.issueNumber, body);
}

function isAppendOnlyIssueCommentMarker(marker: string): boolean {
  return marker === 'workflow:phase-failure';
}

async function createPullRequestWithDuplicateRecovery(
  deps: GitHubActivityDeps,
  input: OpenPullRequestInput,
): Promise<PullRequestResponse> {
  try {
    return await createPullRequest(deps, input);
  } catch (error) {
    if (!isPullRequestAlreadyExistsError(error)) throw error;
    const existingPullRequest = await findOpenPullRequestForBranch(deps, input.worktree);
    if (existingPullRequest) return existingPullRequest;
    throw error;
  }
}

async function findOpenPullRequestForBranch(deps: GitHubActivityDeps, worktree: WorktreeContext): Promise<PullRequestResponse | undefined> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);
  const query = new URLSearchParams({ head: `${worktree.repoOwner}:${worktree.branchName}`, state: 'open', base: worktree.defaultBranch });
  return (await githubRest<PullRequestResponse[]>(deps, `${repoPath}/pulls?${query.toString()}`))[0];
}

function buildCreatedPullRequest(worktree: WorktreeContext, pullRequest: PullRequestResponse): CreatedPullRequest {
  return { branchName: worktree.branchName, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.html_url };
}

function createPullRequest(deps: GitHubActivityDeps, input: OpenPullRequestInput): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(input.worktree.repoOwner, input.worktree.repoName);
  return githubRest<PullRequestResponse>(deps, `${repoPath}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: buildPullRequestTitle(input.worktree, input.title),
      head: input.worktree.branchName,
      base: input.worktree.defaultBranch,
      body: buildPullRequestBody(input.worktree, input.body),
      draft: input.draft ?? false,
    }),
  });
}

function updatePullRequest(
  deps: GitHubActivityDeps,
  worktree: WorktreeContext,
  pullRequestNumber: number,
  title?: string,
  body?: string,
): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);
  return githubRest<PullRequestResponse>(deps, `${repoPath}/pulls/${pullRequestNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: buildPullRequestTitle(worktree, title), body: buildPullRequestBody(worktree, body) }),
  });
}

function createIssueComment(deps: GitHubActivityDeps, repoOwner: string, repoName: string, issueNumber: number, body: string): Promise<unknown> {
  const repoPath = buildRepoApiPath(repoOwner, repoName);
  return githubRest(deps, `${repoPath}/issues/${issueNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

function createPullRequestReviewComment(
  deps: GitHubActivityDeps,
  input: UpsertPullRequestReviewCommentInput,
  body: string,
): Promise<unknown> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  return githubRest(deps, `${repoPath}/pulls/${input.pullRequestNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, commit_id: input.commitId, path: input.path, line: input.line, side: 'RIGHT' }),
  });
}

function updatePullRequestReviewComment(
  deps: GitHubActivityDeps,
  repoOwner: string,
  repoName: string,
  commentId: number,
  body: string,
): Promise<unknown> {
  const repoPath = buildRepoApiPath(repoOwner, repoName);
  return githubRest(deps, `${repoPath}/pulls/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) });
}

function getPullRequest(deps: GitHubActivityDeps, input: GetPullRequestDetailsInput): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  return githubRest<PullRequestResponse>(deps, `${repoPath}/pulls/${input.pullRequestNumber}`, {
    headers: GITHUB_JSON_HEADERS,
  });
}

function updateIssueComment(deps: GitHubActivityDeps, repoOwner: string, repoName: string, commentId: number, body: string): Promise<unknown> {
  const repoPath = buildRepoApiPath(repoOwner, repoName);
  return githubRest(deps, `${repoPath}/issues/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) });
}

function buildPullRequestTitle(worktree: WorktreeContext, title?: string): string {
  return title?.trim() || `chore: dummy change for #${worktree.issueNumber}`;
}

function buildPullRequestBody(worktree: WorktreeContext, body?: string): string {
  return body?.trim() || `Automated dummy change for ${worktree.issueUrl}`;
}