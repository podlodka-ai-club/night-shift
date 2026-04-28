import type { GitHubActivityDeps } from './activity-deps';
import { buildNightShiftMarker } from './comment-markers';
import type {
  CreatedPullRequest,
  IssueComment,
  IssueCommentInput,
  ListIssueCommentsInput,
  OpenPullRequestInput,
  UpsertIssueCommentInput,
  WorktreeContext,
} from './shared';
import { buildRepoApiPath, githubRest, isPullRequestAlreadyExistsError } from './activity-github-client';

interface PullRequestResponse {
  number: number;
  html_url: string;
}

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
  const comments = await githubRest<Array<{ id: number; body: string }>>(deps, `${repoPath}/issues/${input.issueNumber}/comments`);
  return comments.map((comment) => ({ id: comment.id, body: comment.body }));
}

export async function commentOnIssueActivity(deps: GitHubActivityDeps, input: IssueCommentInput): Promise<void> {
  await createIssueComment(deps, input.repoOwner, input.repoName, input.issueNumber, buildIssueComment(input.pullRequestUrl));
}

export async function upsertIssueCommentActivity(deps: GitHubActivityDeps, input: UpsertIssueCommentInput): Promise<void> {
  const existingComment = (await listIssueCommentsActivity(deps, input)).find((comment) => comment.body.includes(buildNightShiftMarker(input.marker)));
  const body = buildMarkerComment(input.marker, input.body);
  if (existingComment) {
    await updateIssueComment(deps, input.repoOwner, input.repoName, existingComment.id, body);
    return;
  }
  await createIssueComment(deps, input.repoOwner, input.repoName, input.issueNumber, body);
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
  return { branchName: worktree.branchName, filePath: worktree.filePath, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.html_url };
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