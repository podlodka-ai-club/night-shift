import type { GitHubClientDeps } from './activity-deps';
import { toErrorMessage } from './activity-deps';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = `${GITHUB_API_URL}/graphql`;
const GITHUB_JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

interface GitHubGraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export function buildRepoApiPath(repoOwner: string, repoName: string): string {
  return `/repos/${repoOwner}/${repoName}`;
}

export async function githubRest<T = unknown>(deps: GitHubClientDeps, path: string, init: RequestInit = {}): Promise<T> {
  const response = await deps.fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${deps.getGitHubToken()}`, ...GITHUB_JSON_HEADERS, ...init.headers },
  });
  return parseGitHubResponse<T>(response);
}

export async function githubGraphql<T>(
  deps: GitHubClientDeps,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await deps.fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.getGitHubToken()}`, ...GITHUB_JSON_HEADERS },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await parseGitHubResponse<GitHubGraphqlEnvelope<T>>(response);
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${payload.errors.map((error) => error.message).join('; ')}`);
  }
  if (!payload.data) {
    throw new Error('GitHub GraphQL response did not contain data.');
  }
  return payload.data;
}

export function isPullRequestAlreadyExistsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('github request failed') && message.includes('422') && message.includes('pull request already exists');
}

export function isMissingProjectOwnerError(error: unknown, ownerType: 'User' | 'Organization'): boolean {
  return error instanceof Error && error.message.includes(`Could not resolve to a ${ownerType} with the login of`);
}

async function parseGitHubResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status} ${response.statusText}): ${text}`);
  }
  if (!text) {
    throw new Error('GitHub request succeeded but returned an empty response body.');
  }
  return JSON.parse(text) as T;
}