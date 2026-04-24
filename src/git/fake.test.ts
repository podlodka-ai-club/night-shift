import { describe, expect, it } from "vitest";
import { createInMemoryFakeGitOps } from "./fake.js";

describe("InMemoryFakeGitOps", () => {
  it("checkout + writeTree produces deterministic shas", async () => {
    const g = createInMemoryFakeGitOps();
    await g.checkoutBranch("night-shift/TICKET-1");
    const a = await g.writeTree([{ path: "a.txt", content: "hi" }], "first");
    const b = await g.writeTree([{ path: "b.txt", content: "bye" }], "second");
    expect(a.sha).toMatch(/^sha1/);
    expect(b.sha).toMatch(/^sha2/);
    expect(a.sha).toHaveLength(40);
    expect(b.sha).toHaveLength(40);
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
});
