import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryFakeWorktreeOps } from "./fake.js";
import { createSimpleGitWorktreeOps } from "./index.js";
import { simpleGit } from "simple-git";

async function makeTempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "ns-worktree-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  await git.commit("initial", [], { "--allow-empty": null });
  return { dir, git };
}

describe("createInMemoryFakeWorktreeOps", () => {
  it("creates and removes a worktree directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ns-fake-wt-"));
    const ops = createInMemoryFakeWorktreeOps({ rootDir: root });
    const out = await ops.create({ ticketId: "t-1", branch: "night-shift/t-1" });
    expect(out.branch).toBe("night-shift/t-1");
    expect((await stat(out.path)).isDirectory()).toBe(true);
    await ops.remove(out.path);
    expect(ops.events.map((e) => e.kind)).toEqual(["create", "remove"]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("createSimpleGitWorktreeOps", () => {
  it("creates a new worktree with a new branch and removes it", async () => {
    const { dir, git } = await makeTempRepo();
    try {
      const ops = createSimpleGitWorktreeOps({ repoRoot: dir, git });
      const out = await ops.create({
        ticketId: "t-9",
        branch: "night-shift/t-9",
      });
      const entries = await readdir(path.join(dir, ".worktrees"));
      expect(entries).toContain("t-9");
      await ops.remove(out.path);
      const after = await readdir(path.join(dir, ".worktrees")).catch(() => []);
      expect(after).not.toContain("t-9");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("remove is a no-op when the path does not exist", async () => {
    const { dir, git } = await makeTempRepo();
    try {
      const ops = createSimpleGitWorktreeOps({ repoRoot: dir, git });
      await expect(
        ops.remove(path.join(dir, ".worktrees", "never-existed")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
