import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages a per-ticket git branch and optional worktree in the target repository.
 */
export class RepoWorkspace {
  private _git: SimpleGit | null = null;

  constructor(private readonly repoDir: string) {}

  private get git(): SimpleGit {
    if (!this._git) {
      this._git = simpleGit(this.repoDir);
    }
    return this._git;
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', '--verify', ref]);
      return true;
    } catch {
      return false;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    return (
      await this.refExists(`refs/heads/${branch}`) ||
      await this.refExists(`refs/remotes/origin/${branch}`)
    );
  }

  /** Ensures the branch is materialized in a worktree, restoring it from origin when needed. */
  async ensureWorktree(branch: string, worktreeDir: string, baseBranch: string): Promise<void> {
    if (fs.existsSync(worktreeDir)) return;

    // Prune stale worktree entries so they don't block a re-add.
    try { await this.git.raw(['worktree', 'prune']); } catch { /* non-fatal */ }

    await this.git.fetch('origin');

    if (await this.refExists(`refs/heads/${branch}`)) {
      await this.git.raw(['worktree', 'add', worktreeDir, branch]);
      return;
    }

    if (await this.refExists(`refs/remotes/origin/${branch}`)) {
      await this.git.raw(['branch', '-f', branch, `origin/${branch}`]);
      await this.git.raw(['worktree', 'add', worktreeDir, branch]);
      return;
    }

    await this.git.raw(['worktree', 'add', '-B', branch, worktreeDir, `origin/${baseBranch}`]);
  }

  /** Creates a new branch from the default branch and checks it out in a worktree. */
  async setup(branch: string, worktreeDir: string, baseBranch: string): Promise<void> {
    await this.ensureWorktree(branch, worktreeDir, baseBranch);
  }

  private async currentBranch(worktreeDir: string): Promise<string> {
    const wt = simpleGit(worktreeDir);
    return (await wt.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  /**
   * Agent runs may create or switch branches inside the worktree.
   * Rebind the expected ticket branch to the current HEAD before publishing.
   */
  private async normalizeBranch(worktreeDir: string, branch: string): Promise<SimpleGit> {
    const wt = simpleGit(worktreeDir);
    const currentBranch = await this.currentBranch(worktreeDir);
    if (currentBranch !== branch) {
      await wt.raw(['checkout', '-B', branch]);
    }
    return wt;
  }

  /** Stages all changes, commits, and pushes the branch to origin. */
  async commitAndPush(worktreeDir: string, branch: string, message: string): Promise<void> {
    const wt = await this.normalizeBranch(worktreeDir, branch);
    await wt.add('--all');
    const status = await wt.status();
    if (status.files.length > 0) {
      await wt.commit(message);
    }
    await wt.push('origin', branch, ['--set-upstream']);
  }

  /** Returns the unified diff of changes in the worktree relative to the default branch. */
  async getDiff(worktreeDir: string, baseBranch: string): Promise<string> {
    await this.git.raw(['fetch', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    const wt = simpleGit(worktreeDir);
    return wt.diff([`origin/${baseBranch}...HEAD`]);
  }

  /** Returns true when the worktree has local modifications not yet committed. */
  async hasUncommittedChanges(worktreeDir: string): Promise<boolean> {
    const wt = simpleGit(worktreeDir);
    const status = await wt.status();
    return status.files.length > 0;
  }

  /** Removes the worktree and deletes the branch. Call on cleanup after PR is merged or run is blocked. */
  async cleanup(worktreeDir: string, branch: string): Promise<void> {
    if (fs.existsSync(worktreeDir)) {
      await this.git.raw(['worktree', 'remove', '--force', worktreeDir]);
    }
    try {
      await this.git.deleteLocalBranch(branch, true);
    } catch {
      // Branch may not exist; ignore.
    }
  }
}
