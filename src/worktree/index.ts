import type { SimpleGit } from "simple-git";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Create and remove on-disk git worktrees so the implement phase can work
 * on each ticket in isolation without blocking the main repo checkout.
 */
export interface WorktreeOps {
  /**
   * Create a new worktree for `branch` under a deterministic path derived
   * from `ticketId`. If the branch does not exist yet it is created from
   * `fromRef` (defaulting to `HEAD`).
   */
  create(opts: {
    ticketId: string;
    branch: string;
    fromRef?: string;
  }): Promise<{ path: string; branch: string }>;
  /** Remove the worktree at `worktreePath` (no-op if already gone). */
  remove(worktreePath: string): Promise<void>;
}

export interface SimpleGitWorktreeOpsDeps {
  repoRoot: string;
  git: SimpleGit;
  /** Base directory for all worktrees; defaults to `<repoRoot>/.worktrees`. */
  worktreesRoot?: string;
}

export function createSimpleGitWorktreeOps(
  deps: SimpleGitWorktreeOpsDeps,
): WorktreeOps {
  const { repoRoot, git } = deps;
  const root = deps.worktreesRoot ?? path.join(repoRoot, ".worktrees");
  return {
    async create({ ticketId, branch, fromRef }) {
      const worktreePath = path.join(root, ticketId);
      const branches = await git.branch();
      const exists =
        branches.all.includes(branch) ||
        branches.all.includes(`remotes/origin/${branch}`);
      const args = ["worktree", "add"];
      if (!exists) {
        args.push("-b", branch);
      }
      args.push(worktreePath);
      if (!exists) {
        args.push(fromRef ?? "HEAD");
      } else {
        args.push(branch);
      }
      await git.raw(args);
      return { path: worktreePath, branch };
    },
    async remove(worktreePath) {
      try {
        await stat(worktreePath);
      } catch {
        return;
      }
      try {
        await git.raw(["worktree", "remove", "--force", worktreePath]);
      } catch {
        // Fall back to a plain rm so stale worktrees don't leak.
        await rm(worktreePath, { recursive: true, force: true });
      }
    },
  };
}
