import type { SimpleGit } from "simple-git";
import { describe, expect, it, vi } from "vitest";
import { createSimpleGitOps } from "../index.js";

describe("createSimpleGitOps", () => {
  it("pushBranch refreshes the remote ref before updating deterministic automation branches", async () => {
    const fetch = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue(undefined);
    const git = { fetch, push } as unknown as SimpleGit;

    const ops = createSimpleGitOps({ repoRoot: "/tmp/repo", git });
    await ops.pushBranch("night-shift/TICKET-1");

    expect(fetch).toHaveBeenCalledWith("origin", "night-shift/TICKET-1");
    expect(push).toHaveBeenCalledWith([
      "--force-with-lease",
      "--set-upstream",
      "origin",
      "HEAD:refs/heads/night-shift/TICKET-1",
    ]);
  });

  it("pushBranch still creates a new remote branch when fetch reports it missing", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("fatal: couldn't find remote ref night-shift/TICKET-1"));
    const push = vi.fn().mockResolvedValue(undefined);
    const git = { fetch, push } as unknown as SimpleGit;

    const ops = createSimpleGitOps({ repoRoot: "/tmp/repo", git });
    await ops.pushBranch("night-shift/TICKET-1");

    expect(push).toHaveBeenCalledOnce();
  });
});