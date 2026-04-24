import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubPushRejectedError } from "../errors.js";
import type { RestClient } from "../issues.js";
import {
  createBranch,
  openPullRequest,
  pushBranch,
  setPullRequestReady,
  upsertPullRequest,
} from "../prs.js";

function makeRest(responses: Array<{ data?: unknown; throw?: unknown }>) {
  const calls: Array<{ route: string; params?: Record<string, unknown> }> = [];
  let i = 0;
  const rest: RestClient = {
    async request<T>(route: string, params?: Record<string, unknown>) {
      calls.push({ route, ...(params !== undefined ? { params } : {}) });
      const r = responses[i++];
      if (!r) throw new Error(`unexpected call ${route}`);
      if (r.throw) throw r.throw;
      return { data: (r.data ?? {}) as T, status: 200, headers: {} };
    },
  };
  return { rest, calls };
}

describe("createBranch", () => {
  it("creates a new branch from the default branch sha", async () => {
    const { rest, calls } = makeRest([
      { data: { default_branch: "main" } },
      { data: { object: { sha: "abc123" } } },
      { data: {} },
    ]);
    const out = await createBranch(rest, {
      owner: "o",
      repo: "r",
      branch: "night-shift/t-1",
    });
    expect(out).toEqual({ ref: "refs/heads/night-shift/t-1", sha: "abc123" });
    expect(calls[2]!.route).toBe("POST /repos/{owner}/{repo}/git/refs");
  });

  it("is idempotent when the branch already points at the same sha", async () => {
    const err = new GitHubApiError(422, "Reference already exists");
    const { rest } = makeRest([
      { data: { default_branch: "main" } },
      { data: { object: { sha: "abc" } } },
      { throw: err },
      { data: { object: { sha: "abc" } } },
    ]);
    const out = await createBranch(rest, { owner: "o", repo: "r", branch: "b" });
    expect(out.sha).toBe("abc");
  });

  it("throws when branch exists at a different sha", async () => {
    const err = new GitHubApiError(422, "Reference already exists");
    const { rest } = makeRest([
      { data: { default_branch: "main" } },
      { data: { object: { sha: "abc" } } },
      { throw: err },
      { data: { object: { sha: "different" } } },
    ]);
    await expect(
      createBranch(rest, { owner: "o", repo: "r", branch: "b" }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("openPullRequest", () => {
  it("returns a PRRef", async () => {
    const { rest } = makeRest([
      {
        data: {
          number: 7,
          html_url: "https://example.com/pr/7",
          head: { ref: "night-shift/t-1", sha: "aaaa1111" },
          base: { ref: "main" },
        },
      },
    ]);
    const pr = await openPullRequest(rest, {
      owner: "o",
      repo: "r",
      head: "night-shift/t-1",
      base: "main",
      title: "Do thing",
    });
    expect(pr.number).toBe(7);
    expect(pr.branch).toBe("night-shift/t-1");
    expect(pr.baseBranch).toBe("main");
    expect(pr.headSha).toBe("aaaa1111");
  });
});

describe("setPullRequestReady", () => {
  it("calls markPullRequestReadyForReview when ready=true", async () => {
    const { rest } = makeRest([{ data: { node_id: "PR_1" } }]);
    const gqlCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const gql = (async (query: string, variables?: Record<string, unknown>) => {
      gqlCalls.push({ query, ...(variables !== undefined ? { variables } : {}) });
      return {};
    }) as never;
    await setPullRequestReady(rest, gql, {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      ready: true,
    });
    expect(gqlCalls[0]!.query).toContain("markPullRequestReadyForReview");
    expect((gqlCalls[0]!.variables as { prId: string }).prId).toBe("PR_1");
  });

  it("calls convertPullRequestToDraft when ready=false", async () => {
    const { rest } = makeRest([{ data: { node_id: "PR_1" } }]);
    const gqlCalls: Array<{ query: string }> = [];
    const gql = (async (query: string) => {
      gqlCalls.push({ query });
      return {};
    }) as never;
    await setPullRequestReady(rest, gql, {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      ready: false,
    });
    expect(gqlCalls[0]!.query).toContain("convertPullRequestToDraft");
  });
});

describe("pushBranch", () => {
  it("PATCHes the ref and returns the new sha", async () => {
    const { rest, calls } = makeRest([{ data: {} }]);
    const out = await pushBranch(rest, {
      owner: "o",
      repo: "r",
      branch: "night-shift/t-1",
      sha: "deadbeef",
    });
    expect(out).toEqual({ ref: "refs/heads/night-shift/t-1", sha: "deadbeef" });
    expect(calls[0]!.route).toBe("PATCH /repos/{owner}/{repo}/git/refs/{ref}");
  });

  it("throws GitHubPushRejectedError on 422 non-fast-forward", async () => {
    const { rest } = makeRest([
      { throw: new GitHubApiError(422, "Update is not a fast forward") },
    ]);
    await expect(
      pushBranch(rest, { owner: "o", repo: "r", branch: "b", sha: "s" }),
    ).rejects.toBeInstanceOf(GitHubPushRejectedError);
  });

  it("falls back to creating the ref when it doesn't exist (404)", async () => {
    const { rest, calls } = makeRest([
      { throw: new GitHubApiError(404, "Not Found") },
      { data: {} },
    ]);
    const out = await pushBranch(rest, {
      owner: "o",
      repo: "r",
      branch: "new",
      sha: "abc",
    });
    expect(out.sha).toBe("abc");
    expect(calls[1]!.route).toBe("POST /repos/{owner}/{repo}/git/refs");
  });
});

describe("upsertPullRequest", () => {
  it("updates an existing PR with the same head branch", async () => {
    const { rest, calls } = makeRest([
      {
        data: [
          {
            number: 42,
            html_url: "https://example.com/pr/42",
            head: { ref: "b", sha: "1111111111111111111111111111111111111111" },
            base: { ref: "main" },
            state: "open",
          },
        ],
      },
      { data: {} },
    ]);
    const pr = await upsertPullRequest(rest, {
      owner: "o",
      repo: "r",
      head: "b",
      base: "main",
      title: "new title",
      body: "new body",
    });
    expect(pr.number).toBe(42);
    expect(calls[0]!.route).toBe("GET /repos/{owner}/{repo}/pulls");
    expect(calls[1]!.route).toBe("PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
  });

  it("creates a PR when none exists for the head branch", async () => {
    const { rest, calls } = makeRest([
      { data: [] },
      {
        data: {
          number: 99,
          html_url: "https://example.com/pr/99",
          head: { ref: "b", sha: "2222222222222222222222222222222222222222" },
          base: { ref: "main" },
        },
      },
    ]);
    const pr = await upsertPullRequest(rest, {
      owner: "o",
      repo: "r",
      head: "b",
      base: "main",
      title: "t",
    });
    expect(pr.number).toBe(99);
    expect(calls[1]!.route).toBe("POST /repos/{owner}/{repo}/pulls");
  });
});
