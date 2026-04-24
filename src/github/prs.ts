import { GitHubApiError, GitHubPushRejectedError } from "./errors.js";
import type { RestClient } from "./issues.js";
import { retryable } from "./retry.js";
import { type PRRef, PRRefSchema } from "./types.js";
import type { GraphQLClient } from "./projects.js";

async function getDefaultBranch(
  rest: RestClient,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await retryable(() =>
    rest.request<{ default_branch: string }>("GET /repos/{owner}/{repo}", {
      owner,
      repo,
    }),
  );
  return data.default_branch;
}

async function getRefSha(
  rest: RestClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const { data } = await retryable(() =>
    rest.request<{ object: { sha: string } }>(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      { owner, repo, ref },
    ),
  );
  return data.object.sha;
}

export async function createBranch(
  rest: RestClient,
  args: {
    owner: string;
    repo: string;
    branch: string;
    fromRef?: string;
  },
): Promise<{ ref: string; sha: string }> {
  const sourceRef =
    args.fromRef ??
    `heads/${await getDefaultBranch(rest, args.owner, args.repo)}`;
  const sha = await getRefSha(rest, args.owner, args.repo, sourceRef);
  const targetRef = `refs/heads/${args.branch}`;

  try {
    await retryable(() =>
      rest.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: args.owner,
        repo: args.repo,
        ref: targetRef,
        sha,
      }),
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      // Branch already exists — tolerate if it points at the same sha.
      const existingSha = await getRefSha(
        rest,
        args.owner,
        args.repo,
        `heads/${args.branch}`,
      );
      if (existingSha === sha) return { ref: targetRef, sha };
      throw new GitHubApiError(
        422,
        `branch ${args.branch} exists at ${existingSha}, wanted ${sha}`,
        err,
      );
    }
    throw err;
  }
  return { ref: targetRef, sha };
}

export interface OpenPROpts {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export async function openPullRequest(
  rest: RestClient,
  opts: OpenPROpts,
): Promise<PRRef> {
  const { data } = await retryable(() =>
    rest.request<{
      number: number;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>("POST /repos/{owner}/{repo}/pulls", {
      owner: opts.owner,
      repo: opts.repo,
      head: opts.head,
      base: opts.base,
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
    }),
  );
  return PRRefSchema.parse({
    number: data.number,
    url: data.html_url,
    branch: data.head.ref,
    baseBranch: data.base.ref,
    headSha: data.head.sha,
  });
}

/**
 * Force-update (or create) the `refs/heads/<branch>` ref to point at `sha`.
 *
 * We prefer PATCH (non-force) first; if the server reports 422 with a
 * non-fast-forward message, we surface a typed `GitHubPushRejectedError`
 * so the caller (the implement phase) can route the item to Blocked.
 */
export async function pushBranch(
  rest: RestClient,
  args: { owner: string; repo: string; branch: string; sha: string },
): Promise<{ ref: string; sha: string }> {
  const ref = `heads/${args.branch}`;
  try {
    await retryable(() =>
      rest.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner: args.owner,
        repo: args.repo,
        ref,
        sha: args.sha,
      }),
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      throw new GitHubPushRejectedError(args.branch, undefined, err);
    }
    if (err instanceof GitHubApiError && err.status === 404) {
      await retryable(() =>
        rest.request("POST /repos/{owner}/{repo}/git/refs", {
          owner: args.owner,
          repo: args.repo,
          ref: `refs/heads/${args.branch}`,
          sha: args.sha,
        }),
      );
      return { ref: `refs/heads/${args.branch}`, sha: args.sha };
    }
    throw err;
  }
  return { ref: `refs/heads/${args.branch}`, sha: args.sha };
}

export interface UpsertPROpts {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/**
 * Open a PR for `head → base`, or update its title/body if one already
 * exists. Idempotent on branch name: never creates duplicate PRs.
 */
export async function upsertPullRequest(
  rest: RestClient,
  opts: UpsertPROpts,
): Promise<PRRef> {
  const { data: existing } = await retryable(() =>
    rest.request<
      Array<{
        number: number;
        html_url: string;
        head: { ref: string; sha: string };
        base: { ref: string };
        state: "open" | "closed";
      }>
    >("GET /repos/{owner}/{repo}/pulls", {
      owner: opts.owner,
      repo: opts.repo,
      head: `${opts.owner}:${opts.head}`,
      state: "open",
      per_page: 1,
    }),
  );
  if (existing.length > 0) {
    const pr = existing[0]!;
    await retryable(() =>
      rest.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr.number,
        title: opts.title,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      }),
    );
    return PRRefSchema.parse({
      number: pr.number,
      url: pr.html_url,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
    });
  }
  return await openPullRequest(rest, opts);
}

const MARK_READY_MUTATION = /* GraphQL */ `
  mutation MarkReady($prId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $prId }) {
      pullRequest { id }
    }
  }
`;

const CONVERT_DRAFT_MUTATION = /* GraphQL */ `
  mutation ConvertDraft($prId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $prId }) {
      pullRequest { id }
    }
  }
`;

export async function setPullRequestReady(
  rest: RestClient,
  gql: GraphQLClient,
  args: { owner: string; repo: string; pullNumber: number; ready: boolean },
): Promise<void> {
  // Resolve node_id via REST — cheap and avoids an extra GraphQL query path.
  const { data } = await retryable(() =>
    rest.request<{ node_id: string }>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner: args.owner, repo: args.repo, pull_number: args.pullNumber },
    ),
  );
  const mutation = args.ready ? MARK_READY_MUTATION : CONVERT_DRAFT_MUTATION;
  await retryable(() => gql(mutation, { prId: data.node_id }));
}
