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

  it("checkoutBranch creates a local branch from the fetched remote branch when available", async () => {
    const branchLocal = vi.fn().mockResolvedValue({ all: ["main"] });
    const fetch = vi.fn().mockResolvedValue(undefined);
    const branch = vi.fn().mockResolvedValue({
      all: ["main", "remotes/origin/night-shift/TICKET-1"],
    });
    const checkout = vi.fn().mockResolvedValue(undefined);
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const checkoutLocalBranch = vi.fn().mockResolvedValue(undefined);
    const git = {
      branchLocal,
      fetch,
      branch,
      checkout,
      checkoutBranch,
      checkoutLocalBranch,
    } as unknown as SimpleGit;

    const ops = createSimpleGitOps({ repoRoot: "/tmp/repo", git });
    await ops.checkoutBranch("night-shift/TICKET-1", { preferRemote: true, startPoint: "main" });

    expect(fetch).toHaveBeenCalledWith("origin", "night-shift/TICKET-1");
    expect(checkoutBranch).toHaveBeenCalledWith(
      "night-shift/TICKET-1",
      "origin/night-shift/TICKET-1",
    );
    expect(checkoutLocalBranch).not.toHaveBeenCalled();
  });

  it("checkoutBranch creates a new local branch from the configured base when the ticket branch does not exist remotely", async () => {
    const branchLocal = vi.fn().mockResolvedValue({ all: ["main"] });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("fatal: couldn't find remote ref night-shift/TICKET-1"))
      .mockResolvedValueOnce(undefined);
    const branch = vi.fn().mockResolvedValue({
      all: ["main", "remotes/origin/main"],
    });
    const checkout = vi.fn().mockResolvedValue(undefined);
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const checkoutLocalBranch = vi.fn().mockResolvedValue(undefined);
    const git = {
      branchLocal,
      fetch,
      branch,
      checkout,
      checkoutBranch,
      checkoutLocalBranch,
    } as unknown as SimpleGit;

    const ops = createSimpleGitOps({ repoRoot: "/tmp/repo", git });
    await ops.checkoutBranch("night-shift/TICKET-1", { preferRemote: true, startPoint: "main" });

    expect(fetch).toHaveBeenNthCalledWith(1, "origin", "night-shift/TICKET-1");
    expect(fetch).toHaveBeenNthCalledWith(2, "origin", "main");
    expect(checkoutBranch).toHaveBeenCalledWith(
      "night-shift/TICKET-1",
      "origin/main",
    );
    expect(checkoutLocalBranch).not.toHaveBeenCalled();
  });
});