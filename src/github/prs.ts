import { GitHubApiError, GitHubPushRejectedError } from "./errors.js";
import type { RestClient } from "./issues.js";
import { markerLine } from "./issues.js";
import { retryable } from "./retry.js";
import {
  ChangedFileSchema,
  ReviewCommentSchema,
  ReviewSchema,
  type ChangedFile,
  type PRRef,
  type Review,
  type ReviewComment,
} from "./types.js";
import { PRRefSchema } from "./types.js";
import type { GraphQLClient } from "./projects.js";

const PUSH_REJECTED_422_PATTERNS = [
  /non-fast-forward/i,
  /fast[ -]forward/i,
  /\bis at [0-9a-f]{7,40}\b.*\bexpected [0-9a-f]{7,40}\b/i,
  /\bexpected [0-9a-f]{7,40}\b.*\bfound [0-9a-f]{7,40}\b/i,
];

function isPushRejected422(err: GitHubApiError): boolean {
  return PUSH_REJECTED_422_PATTERNS.some((pattern) => pattern.test(err.message));
}

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
    if (
      err instanceof GitHubApiError &&
      err.status === 422 &&
      isPushRejected422(err)
    ) {
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

export async function getPullRequestDiff(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const { data } = await retryable(() =>
    rest.request<string>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
      headers: { accept: "application/vnd.github.v3.diff" },
    }),
  );
  return data;
}

export async function getFileContent(
  rest: RestClient,
  owner: string,
  repo: string,
  filePath: string,
  ref?: string,
): Promise<string> {
  const { data } = await retryable(() =>
    rest.request<{
      content?: string;
      encoding?: string;
      type?: string;
    }>("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: filePath,
      ...(ref !== undefined ? { ref } : {}),
    }),
  );

  if (data.type !== "file" || typeof data.content !== "string") {
    throw new GitHubApiError(422, `path ${filePath} is not a file`);
  }

  if (data.encoding !== "base64") {
    throw new GitHubApiError(
      422,
      `unsupported encoding for ${filePath}: ${data.encoding ?? "unknown"}`,
    );
  }

  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function listChangedFiles(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  let page = 1;
  const perPage = 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await retryable(() =>
      rest.request<
        Array<{
          filename: string;
          additions: number;
          deletions: number;
          status: string;
        }>
      >("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      }),
    );
    for (const f of data) {
      out.push(
        ChangedFileSchema.parse({
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          status: f.status === "renamed" ? "renamed" :
            f.status === "added" ? "added" :
            f.status === "removed" ? "removed" : "modified",
        }),
      );
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

export async function listReviewComments(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewComment[]> {
  const out: ReviewComment[] = [];
  let page = 1;
  const perPage = 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await retryable(() =>
      rest.request<
        Array<{
          id: number;
          body: string;
          path: string;
          line: number | null;
        }>
      >("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      }),
    );
    for (const c of data) {
      out.push(
        ReviewCommentSchema.parse({
          id: c.id,
          body: c.body,
          path: c.path,
          line: c.line ?? null,
        }),
      );
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

const VALID_REVIEW_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

export async function upsertReviewComment(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
  markerId: string,
  opts: { path: string; line: number; body: string },
): Promise<{ commentId: number }> {
  const marker = markerLine(markerId);
  const bodyWithMarker = opts.body.startsWith(marker)
    ? opts.body
    : `${marker}\n${opts.body}`;

  // Search existing review comments for a match
  const existing = await listReviewComments(rest, owner, repo, pullNumber);
  const match = existing.find(
    (c) =>
      c.body.startsWith(marker) &&
      c.path === opts.path &&
      c.line === opts.line,
  );

  if (match) {
    await retryable(() =>
      rest.request(
        "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}",
        {
          owner,
          repo,
          comment_id: match.id,
          body: bodyWithMarker,
        },
      ),
    );
    return { commentId: match.id };
  }

  const commitId = await getHeadSha(rest, owner, repo, pullNumber);
  const { data } = await retryable(() =>
    rest.request<{ id: number }>(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        owner,
        repo,
        pull_number: pullNumber,
        body: bodyWithMarker,
        path: opts.path,
        line: opts.line,
        commit_id: commitId,
      },
    ),
  );
  return { commentId: data.id };
}

async function getHeadSha(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const { data } = await retryable(() =>
    rest.request<{ head: { sha: string } }>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: pullNumber },
    ),
  );
  return data.head.sha;
}

export async function createReview(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
  opts: { event: string; body: string },
): Promise<{ id: number }> {
  if (!VALID_REVIEW_EVENTS.has(opts.event)) {
    throw new GitHubApiError(
      422,
      `unsupported review event: ${opts.event}`,
    );
  }
  const { data } = await retryable(() =>
    rest.request<{ id: number }>(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo,
        pull_number: pullNumber,
        event: opts.event,
        body: opts.body,
      },
    ),
  );
  return { id: data.id };
}

export async function listReviews(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Review[]> {
  const out: Review[] = [];
  let page = 1;
  const perPage = 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await retryable(() =>
      rest.request<
        Array<{
          id: number;
          body: string;
          state: string;
          author_association: string;
        }>
      >("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      }),
    );
    for (const r of data) {
      out.push(
        ReviewSchema.parse({
          id: r.id,
          body: r.body,
          state: r.state,
          authorAssociation: r.author_association,
        }),
      );
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

export async function updateReview(
  rest: RestClient,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  opts: { body: string },
): Promise<void> {
  await retryable(() =>
    rest.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
      {
        owner,
        repo,
        pull_number: pullNumber,
        review_id: reviewId,
        body: opts.body,
      },
    ),
  );
}
