import type { SimpleGit } from "simple-git";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Minimal git surface the specify phase needs. Kept intentionally tiny so
 * we can swap in an in-memory fake for tests and a real `simple-git` impl
 * at runtime.
 */
export interface GitOps {
  /** Checkout the given branch, creating it from the current HEAD if absent. */
  checkoutBranch(branch: string): Promise<void>;
  /**
   * Stage the given files (paths relative to the repo root) with the given
   * contents, commit them, and return the new HEAD sha.
   */
  writeTree(
    files: Array<{ path: string; content: string }>,
    commitMessage: string,
  ): Promise<{ sha: string }>;
  /** Return the current HEAD sha. */
  currentHeadSha(): Promise<string>;
  /**
   * Return the unified diff of the current HEAD against the merge-base with
   * `baseBranch` (e.g. `main`). Always returns a plain string — empty when
   * there are no changes.
   */
  diffAgainstBase(baseBranch: string): Promise<string>;
}

export interface SimpleGitOpsDeps {
  repoRoot: string;
  git: SimpleGit;
  /** Optional overrides so callers can pin the commit identity in tests. */
  authorName?: string;
  authorEmail?: string;
}

/**
 * `simple-git`-backed `GitOps` implementation. Callers are responsible for
 * constructing the `SimpleGit` instance — this module does not import
 * `simple-git` itself so tests can run without a real repo.
 */
export function createSimpleGitOps(deps: SimpleGitOpsDeps): GitOps {
  const { repoRoot, git } = deps;
  return {
    async checkoutBranch(branch) {
      const branches = await git.branch();
      if (branches.all.includes(branch) || branches.all.includes(`remotes/origin/${branch}`)) {
        await git.checkout(branch);
      } else {
        await git.checkoutLocalBranch(branch);
      }
    },
    async writeTree(files, commitMessage) {
      for (const f of files) {
        const full = path.join(repoRoot, f.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, f.content, "utf8");
      }
      await git.add(files.map((f) => f.path));
      const env: Record<string, string> = {};
      if (deps.authorName) {
        env.GIT_AUTHOR_NAME = deps.authorName;
        env.GIT_COMMITTER_NAME = deps.authorName;
      }
      if (deps.authorEmail) {
        env.GIT_AUTHOR_EMAIL = deps.authorEmail;
        env.GIT_COMMITTER_EMAIL = deps.authorEmail;
      }
      if (Object.keys(env).length > 0) {
        git.env(env);
      }
      await git.commit(commitMessage);
      const sha = await git.revparse(["HEAD"]);
      return { sha: sha.trim() };
    },
    async currentHeadSha() {
      const sha = await git.revparse(["HEAD"]);
      return sha.trim();
    },
    async diffAgainstBase(baseBranch) {
      // `...` yields the diff from the merge-base, which is what reviewers
      // expect on PRs. Fall back to a direct diff when the merge-base lookup
      // fails (e.g. unrelated histories).
      try {
        return await git.diff([`${baseBranch}...HEAD`]);
      } catch {
        return await git.diff([baseBranch, "HEAD"]);
      }
    },
  };
}
