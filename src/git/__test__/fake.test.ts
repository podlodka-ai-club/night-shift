import { describe, expect, it } from "vitest";
import { createInMemoryFakeGitOps } from "./fake.js";

describe("InMemoryFakeGitOps", () => {
  it("checkout + writeTree produces deterministic shas", async () => {
    const g = createInMemoryFakeGitOps();
    await g.checkoutBranch("night-shift/TICKET-1");
    const a = await g.writeTree([{ path: "a.txt", content: "hi" }], "first");
    const b = await g.writeTree([{ path: "b.txt", content: "bye" }], "second");
    expect(a.sha).toMatch(/^a1/);
    expect(b.sha).toMatch(/^a2/);
    expect(a.sha).toHaveLength(40);
    expect(b.sha).toHaveLength(40);
    expect(/^[0-9a-f]{40}$/.test(a.sha)).toBe(true);
    expect(await g.currentHeadSha()).toBe(b.sha);
    expect(g.branch).toBe("night-shift/TICKET-1");
  });

  it("tracks committed file contents (latest wins)", async () => {
    const g = createInMemoryFakeGitOps();
    await g.writeTree([{ path: "spec.md", content: "v1" }], "c1");
    await g.writeTree([{ path: "spec.md", content: "v2" }], "c2");
    expect(g.files.get("spec.md")).toBe("v2");
    expect(g.commits).toHaveLength(2);
    expect(g.commits[0]!.message).toBe("c1");
  });

  it("currentHeadSha before any commit is a zero sha", async () => {
    const g = createInMemoryFakeGitOps();
    expect(await g.currentHeadSha()).toBe("0".repeat(40));
  });

  it("diffAgainstBase returns a synthetic diff of branch commits", async () => {
    const g = createInMemoryFakeGitOps();
    await g.checkoutBranch("feat/x");
    await g.writeTree([{ path: "a.txt", content: "hello" }], "c1");
    const diff = await g.diffAgainstBase("main");
    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+hello");
  });

  it("diffAgainstBase is empty before any non-base commits", async () => {
    const g = createInMemoryFakeGitOps();
    expect(await g.diffAgainstBase("main")).toBe("");
  });

  it("pushBranch records the current head sha for the target branch", async () => {
    const g = createInMemoryFakeGitOps();
    await g.checkoutBranch("feat/x");
    const commit = await g.writeTree([{ path: "a.txt", content: "hello" }], "c1");

    await g.pushBranch("feat/x");

    expect(g.pushes).toEqual([{ branch: "feat/x", sha: commit.sha }]);
  });
});
