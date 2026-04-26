import type { GitHubActivityDeps } from './activity-deps';
import type { CreatedPullRequest, IssueCommentInput, OpenPullRequestInput, WorktreeContext } from './shared';
import {
  buildRepoApiPath,
  githubRest,
  isPullRequestAlreadyExistsError,
} from './activity-github-client';

interface PullRequestResponse {
  number: number;
  html_url: string;
}

export function buildIssueComment(pullRequestUrl: string): string {
  return `Opened a pull request for this issue: ${pullRequestUrl}`;
}

export async function openPullRequestActivity(
  deps: GitHubActivityDeps,
  input: OpenPullRequestInput,
): Promise<CreatedPullRequest> {
  const { worktree, title, body } = input;
  const existingPullRequest = await findOpenPullRequestForBranch(deps, worktree);
  if (existingPullRequest) {
    return buildCreatedPullRequest(worktree, existingPullRequest);
  }

  return buildCreatedPullRequest(worktree, await createPullRequestWithDuplicateRecovery(deps, worktree, title, body));
}

export async function commentOnIssueActivity(
  deps: GitHubActivityDeps,
  input: IssueCommentInput,
): Promise<void> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);
  await githubRest(deps, `${repoPath}/issues/${input.issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: buildIssueComment(input.pullRequestUrl) }),
  });
}

async function createPullRequestWithDuplicateRecovery(
  deps: GitHubActivityDeps,
  worktree: WorktreeContext,
  title?: string,
  body?: string,
): Promise<PullRequestResponse> {
  try {
    return await createPullRequest(deps, worktree, title, body);
  } catch (error) {
    if (!isPullRequestAlreadyExistsError(error)) {
      throw error;
    }

    const existingPullRequest = await findOpenPullRequestForBranch(deps, worktree);
    if (existingPullRequest) {
      return existingPullRequest;
    }

    throw error;
  }
}

async function findOpenPullRequestForBranch(
  deps: GitHubActivityDeps,
  worktree: WorktreeContext,
): Promise<PullRequestResponse | undefined> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);
  const query = new URLSearchParams({
    head: `${worktree.repoOwner}:${worktree.branchName}`,
    state: 'open',
    base: worktree.defaultBranch,
  });
  const pullRequests = await githubRest<PullRequestResponse[]>(deps, `${repoPath}/pulls?${query.toString()}`);
  return pullRequests[0];
}

function buildCreatedPullRequest(worktree: WorktreeContext, pullRequest: PullRequestResponse): CreatedPullRequest {
  return {
    branchName: worktree.branchName,
    filePath: worktree.filePath,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
  };
}

async function createPullRequest(
  deps: GitHubActivityDeps,
  worktree: WorktreeContext,
  title?: string,
  body?: string,
): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);
  return githubRest<PullRequestResponse>(deps, `${repoPath}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: buildPullRequestTitle(worktree, title),
      head: worktree.branchName,
      base: worktree.defaultBranch,
      body: buildPullRequestBody(worktree, body),
    }),
  });
}

function buildPullRequestTitle(worktree: WorktreeContext, title?: string): string {
  return title?.trim() || `chore: dummy change for #${worktree.issueNumber}`;
}

function buildPullRequestBody(worktree: WorktreeContext, body?: string): string {
  return body?.trim() || `Automated dummy change for ${worktree.issueUrl}`;
}