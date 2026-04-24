import { describe, expect, it } from "vitest";
import {
  addLabels,
  ensureLabel,
  getIssue,
  listComments,
  markerLine,
  removeLabel,
  upsertComment,
} from "../issues.js";
import type { RestClient } from "../issues.js";

type Call = { route: string; params?: Record<string, unknown> };

function makeRest(responses: Array<{ data?: unknown; status?: number; throw?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const rest: RestClient = {
    async request<T>(route: string, params?: Record<string, unknown>) {
      calls.push({ route, ...(params !== undefined ? { params } : {}) });
      const r = responses[i++];
      if (!r) throw new Error(`unexpected call ${route}`);
      if (r.throw) throw r.throw;
      return {
        data: (r.data ?? {}) as T,
        status: r.status ?? 200,
        headers: {},
      };
    },
  };
  return { rest, calls };
}

describe("getIssue", () => {
  it("parses the response into Issue", async () => {
    const { rest } = makeRest([
      {
        data: {
          number: 1,
          title: "t",
          body: "b",
          state: "open",
          labels: [{ name: "bug" }, "tag2"],
          html_url: "https://example.com",
        },
      },
    ]);
    const issue = await getIssue(rest, "acme", "w", 1);
    expect(issue.labels).toEqual(["bug", "tag2"]);
    expect(issue.state).toBe("open");
  });
});

describe("ensureLabel", () => {
  it("is a no-op on 422 already_exists", async () => {
    const err = Object.assign(new Error("Validation Failed: already_exists"), { status: 422 });
    const { rest, calls } = makeRest([{ throw: err }]);
    await ensureLabel(rest, "o", "r", "night-shift:bug");
    expect(calls).toHaveLength(1);
  });

  it("rethrows non-exists 422 and non-retryable errors", async () => {
    const err = Object.assign(new Error("validation: bad color"), { status: 422 });
    const { rest, calls } = makeRest([{ throw: err }]);
    await expect(ensureLabel(rest, "o", "r", "x")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("addLabels", () => {
  it("ensures each label then applies them", async () => {
    const { rest, calls } = makeRest([
      { data: { name: "a", color: "ededed" } },
      { data: { name: "b", color: "ededed" } },
      { data: {} },
    ]);
    await addLabels(rest, "o", "r", 1, ["a", "b"]);
    expect(calls[0]!.route).toBe("POST /repos/{owner}/{repo}/labels");
    expect(calls[1]!.route).toBe("POST /repos/{owner}/{repo}/labels");
    expect(calls[2]!.route).toBe(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    );
  });
});

describe("removeLabel", () => {
  it("tolerates 404 (label already removed)", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    const { rest } = makeRest([{ throw: err }]);
    await expect(removeLabel(rest, "o", "r", 1, "x")).resolves.toBeUndefined();
  });
});

describe("upsertComment", () => {
  const marker = markerLine("specify:open-questions");

  it("creates a new comment when none matches the marker", async () => {
    const { rest, calls } = makeRest([
      { data: [] },
      { data: { id: 101 } },
    ]);
    const out = await upsertComment(rest, "o", "r", 1, "specify:open-questions", "Q1");
    expect(out.commentId).toBe(101);
    const postCall = calls[1]!;
    expect(postCall.route).toContain("POST");
    const body = (postCall.params as { body: string }).body;
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain("Q1");
  });

  it("updates an existing comment matching the marker", async () => {
    const { rest, calls } = makeRest([
      { data: [{ id: 5, body: `${marker}\nold body` }] },
      { data: { id: 5 } },
    ]);
    const out = await upsertComment(rest, "o", "r", 1, "specify:open-questions", "new");
    expect(out.commentId).toBe(5);
    expect(calls[1]!.route).toContain("PATCH");
    const body = (calls[1]!.params as { body: string }).body;
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain("new");
  });

  it("ignores unrelated comments", async () => {
    const { rest, calls } = makeRest([
      { data: [{ id: 2, body: "unrelated" }, { id: 3, body: "also unrelated" }] },
      { data: { id: 999 } },
    ]);
    const out = await upsertComment(rest, "o", "r", 1, "specify:open-questions", "Q");
    expect(out.commentId).toBe(999);
    expect(calls[1]!.route).toContain("POST");
  });
});

describe("listComments", () => {
  it("returns [] for an issue with no comments", async () => {
    const { rest } = makeRest([{ data: [] }]);
    const out = await listComments(rest, "o", "r", 42);
    expect(out).toEqual([]);
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `b${i + 1}`,
      user: { login: "u" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: i + 101,
      body: `b${i + 101}`,
      user: { login: "u" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const { rest, calls } = makeRest([{ data: page1 }, { data: page2 }]);
    const out = await listComments(rest, "o", "r", 42);
    expect(out).toHaveLength(150);
    expect(out[0]!.id).toBe(1);
    expect(out[149]!.id).toBe(150);
    expect((calls[0]!.params as { page: number }).page).toBe(1);
    expect((calls[1]!.params as { page: number }).page).toBe(2);
  });
});
