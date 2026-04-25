import { describe, expect, it } from "vitest";
import { createInMemoryFakeGitHubClient } from "./fake.js";
import { GitHubNotFoundError } from "../errors.js";

describe("InMemoryFakeGitHubClient", () => {
  it("supports the full status lifecycle on a seeded item", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Backlog" });
    await c.setStatus("PVTI_1", "Ready");
    const item = await c.getItem("PVTI_1");
    expect(item.status).toBe("Ready");
    expect(item.issueNumber).toBe(1);
    expect(item.ticketId).toBe("1");
    expect(item.title).toBe("Item PVTI_1");
    expect(c.events.map((e) => e.kind)).toEqual(["setStatus", "getItem"]);
  });

  it("getItem returns seeded ticketId and title", async () => {
    const c = createInMemoryFakeGitHubClient();
    c.seedItem({ itemId: "PVTI_abc", ticketId: "T-42", title: "Fix login", issueNumber: 42, status: "Backlog" });
    const item = await c.getItem("PVTI_abc");
    expect(item.ticketId).toBe("T-42");
    expect(item.title).toBe("Fix login");
    expect(item.issueNumber).toBe(42);
    expect(item.status).toBe("Backlog");
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

  it("pushBranch updates the branch sha and any open PR's headSha", async () => {
    const c = createInMemoryFakeGitHubClient();
    await c.createBranch("night-shift/t-1");
    const pr = await c.openPullRequest({
      head: "night-shift/t-1",
      base: "main",
      title: "x",
    });
    await c.pushBranch("night-shift/t-1", "abc123");
    const again = await c.upsertPullRequest({
      head: "night-shift/t-1",
      base: "main",
      title: "y",
    });
    expect(again.number).toBe(pr.number);
    expect(again.headSha).toBe("abc123");
  });

  it("upsertPullRequest creates a new PR when none exists", async () => {
    const c = createInMemoryFakeGitHubClient();
    const pr = await c.upsertPullRequest({
      head: "night-shift/t-2",
      base: "main",
      title: "t",
    });
    expect(pr.number).toBe(1);
    expect(pr.branch).toBe("night-shift/t-2");
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

  describe("listItemsByStatus", () => {
    it("returns matching items with all fields", async () => {
      const c = createInMemoryFakeGitHubClient();
      c.seedItem({ itemId: "PVTI_1", issueNumber: 1, title: "Fix login", status: "Backlog", createdAt: "2026-01-01T00:00:00Z" });
      c.seedItem({ itemId: "PVTI_2", issueNumber: 2, title: "Add tests", status: "Ready" });
      c.seedItem({ itemId: "PVTI_3", issueNumber: 3, title: "Refactor", status: "Backlog", createdAt: "2026-01-02T00:00:00Z" });

      const items = await c.listItemsByStatus("Backlog");
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        itemId: "PVTI_1",
        issueNumber: 1,
        title: "Fix login",
        ticketId: "1",
        createdAt: "2026-01-01T00:00:00Z",
      });
      expect(items[1]!.itemId).toBe("PVTI_3");
    });

    it("returns empty array when no items match", async () => {
      const c = createInMemoryFakeGitHubClient();
      c.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Ready" });
      const items = await c.listItemsByStatus("Backlog");
      expect(items).toEqual([]);
    });

    it("orders results by createdAt ascending", async () => {
      const c = createInMemoryFakeGitHubClient();
      c.seedItem({ itemId: "PVTI_B", issueNumber: 2, status: "Backlog", createdAt: "2026-03-01T00:00:00Z" });
      c.seedItem({ itemId: "PVTI_A", issueNumber: 1, status: "Backlog", createdAt: "2026-01-01T00:00:00Z" });
      c.seedItem({ itemId: "PVTI_C", issueNumber: 3, status: "Backlog", createdAt: "2026-02-01T00:00:00Z" });

      const items = await c.listItemsByStatus("Backlog");
      expect(items.map((i) => i.itemId)).toEqual(["PVTI_A", "PVTI_C", "PVTI_B"]);
    });

    it("excludes items without issueNumber", async () => {
      const c = createInMemoryFakeGitHubClient();
      c.seedItem({ itemId: "PVTI_no_issue", status: "Backlog" });
      const items = await c.listItemsByStatus("Backlog");
      expect(items).toEqual([]);
    });

    it("logs the listItemsByStatus event", async () => {
      const c = createInMemoryFakeGitHubClient();
      await c.listItemsByStatus("Backlog");
      expect(c.events.at(-1)!.kind).toBe("listItemsByStatus");
    });
  });
});
