import { describe, expect, it } from "vitest";
import { createInMemoryFakeGitHubClient } from "./fake.js";
import { GitHubNotFoundError } from "./errors.js";

describe("InMemoryFakeGitHubClient", () => {
  it("supports the full status lifecycle on a seeded item", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Backlog" });
    await c.setStatus("PVTI_1", "Ready");
    const item = await c.getItem("PVTI_1");
    expect(item.status).toBe("Ready");
    expect(item.issueNumber).toBe(1);
    expect(c.events.map((e) => e.kind)).toEqual(["setStatus", "getItem"]);
  });

  it("adds and removes labels on a seeded issue", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedIssue({ number: 10 });
    await c.addLabels(10, ["a", "b"]);
    await c.removeLabel(10, "a");
    const i = await c.getIssue(10);
    expect(i.labels).toEqual(["b"]);
  });

  it("upserts a comment matching the marker", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedIssue({ number: 1 });
    const first = await c.upsertComment(1, "specify:open-questions", "q1");
    const second = await c.upsertComment(1, "specify:open-questions", "q1-updated");
    expect(first.commentId).toBe(second.commentId);
  });

  it("listComments returns seeded comments in insertion order", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedIssue({ number: 42 });
    await c.upsertComment(42, "m1", "a");
    await c.upsertComment(42, "m2", "b");
    const comments = await c.listComments(42);
    expect(comments).toHaveLength(2);
    expect(comments[0]!.body).toContain("night-shift:marker=m1");
    expect(comments[1]!.body).toContain("night-shift:marker=m2");
  });

  it("listComments returns [] for issues with no comments", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedIssue({ number: 7 });
    await expect(c.listComments(7)).resolves.toEqual([]);
  });

  it("opens PRs with incrementing numbers and can toggle draft", async () => {
    const c = createInMemoryFakeGitHubClient();
    await c.createBranch("night-shift/t-1");
    const pr = await c.openPullRequest({
      head: "night-shift/t-1",
      base: "main",
      title: "x",
    });
    expect(pr.number).toBe(1);
    await c.setPullRequestReady(pr.number, true);
  });

  it("throws GitHubNotFoundError for missing items", async () => {
    const c = createInMemoryFakeGitHubClient();
    await expect(c.getItem("nope")).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it("records an event via emitFakeWebhook", () => {
    const c = createInMemoryFakeGitHubClient();
    const ev = c.emitFakeWebhook({
      kind: "ignored",
      deliveryId: "d",
      reason: "testing",
    });
    expect(ev.kind).toBe("ignored");
    expect(c.events.at(-1)!.kind).toBe("emitFakeWebhook");
  });
});
