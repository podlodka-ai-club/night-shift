import type { GitOps } from "../index.js";

export interface FakeGitOps extends GitOps {
  /** Current HEAD branch. */
  readonly branch: string;
  /** Files committed so far, keyed by path, latest wins. */
  readonly files: ReadonlyMap<string, string>;
  /** Ordered list of commits produced by `writeTree`. */
  readonly commits: ReadonlyArray<{
    sha: string;
    branch: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }>;
}

/**
 * In-memory fake used by unit tests. Commit shas are deterministic
 * (`sha-<N>` padded to 40 hex chars) so assertions stay stable.
 */
export function createInMemoryFakeGitOps(initialBranch = "main"): FakeGitOps {
  let branch = initialBranch;
  const branches = new Set<string>([initialBranch]);
  const files = new Map<string, string>();
  const commits: Array<{
    sha: string;
    branch: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }> = [];
  let nextSha = 1;
  let head = "0".repeat(40);

  const padSha = (n: number): string => {
    // Hex-only so downstream schemas that validate `^[0-9a-f]{7,40}$`
    // accept these shas. Prefix with "a" to avoid leading-zero shas.
    const hex = `a${n.toString(16)}`;
    return hex + "0".repeat(40 - hex.length);
  };

  const ops: FakeGitOps = {
    get branch() {
      return branch;
    },
    get files() {
      return files;
    },
    get commits() {
      return commits;
    },
    async checkoutBranch(b) {
      branch = b;
      branches.add(b);
    },
    async writeTree(newFiles, commitMessage) {
      for (const f of newFiles) files.set(f.path, f.content);
      const sha = padSha(nextSha++);
      commits.push({
        sha,
        branch,
        message: commitMessage,
        files: newFiles.map((f) => ({ ...f })),
      });
      head = sha;
      return { sha };
    },
    async currentHeadSha() {
      return head;
    },
    async diffAgainstBase(baseBranch) {
      // Synthetic diff: list every file introduced on the current branch
      // since we switched away from `baseBranch`. Good enough for the
      // fake, which is only exercised by unit tests.
      const fromCurrent = commits.filter((c) => c.branch !== baseBranch);
      if (fromCurrent.length === 0) return "";
      const lines: string[] = [];
      for (const c of fromCurrent) {
        for (const f of c.files) {
          lines.push(`diff --git a/${f.path} b/${f.path}`);
          lines.push(`+++ b/${f.path}`);
          for (const line of f.content.split("\n")) lines.push(`+${line}`);
        }
      }
      return lines.join("\n");
    },
  };
  return ops;
}
