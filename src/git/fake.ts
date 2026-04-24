import type { GitOps } from "./index.js";

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
    const base = `sha${n}`;
    return base + "0".repeat(40 - base.length);
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
  };
  return ops;
}
