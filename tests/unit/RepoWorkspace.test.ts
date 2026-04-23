import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repoGit, worktreeGit, simpleGitMock } = vi.hoisted(() => {
  const repoGit = {
    raw: vi.fn().mockResolvedValue(''),
    fetch: vi.fn().mockResolvedValue(undefined),
    deleteLocalBranch: vi.fn().mockResolvedValue(undefined),
  };

  const worktreeGit = {
    raw: vi.fn().mockResolvedValue('feature-factory/test-branch\n'),
    diff: vi.fn().mockResolvedValue('diff --git a/src/foo.ts\n+const x = 1;'),
    add: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ files: [] }),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
  };

  const simpleGitMock = vi.fn((baseDir?: string) => {
    if (baseDir === '/tmp/repo') return repoGit;
    return worktreeGit;
  });

  return { repoGit, worktreeGit, simpleGitMock };
});

vi.mock('simple-git', () => ({
  simpleGit: simpleGitMock,
}));

import { RepoWorkspace } from '../../src/workspace/RepoWorkspace';

describe('RepoWorkspace.getDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoGit.raw.mockResolvedValue('');
    worktreeGit.raw.mockResolvedValue('feature-factory/test-branch\n');
    worktreeGit.status.mockResolvedValue({ files: [] });
    worktreeGit.diff.mockResolvedValue('diff --git a/src/foo.ts\n+const x = 1;');
  });

  it('fetches the remote base branch before diffing against origin/<base>', async () => {
    const workspace = new RepoWorkspace('/tmp/repo');

    const diff = await workspace.getDiff('/tmp/worktree', 'main');

    expect(repoGit.raw).toHaveBeenCalledWith([
      'fetch',
      'origin',
      'main:refs/remotes/origin/main',
    ]);
    expect(worktreeGit.diff).toHaveBeenCalledWith(['origin/main...HEAD']);
    expect(diff).toContain('diff --git');
  });

  it('pushes the ticket branch even when there are no uncommitted files', async () => {
    const workspace = new RepoWorkspace('/tmp/repo');

    await workspace.commitAndPush('/tmp/worktree', 'feature-factory/test-branch', 'feat: publish');

    expect(worktreeGit.raw).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(worktreeGit.commit).not.toHaveBeenCalled();
    expect(worktreeGit.push).toHaveBeenCalledWith('origin', 'feature-factory/test-branch', ['--set-upstream']);
  });

  it('rebinds the ticket branch to HEAD when the worktree is on a different branch', async () => {
    worktreeGit.raw
      .mockResolvedValueOnce('deps/fix/conflicts-001\n')
      .mockResolvedValueOnce('');

    const workspace = new RepoWorkspace('/tmp/repo');

    await workspace.commitAndPush('/tmp/worktree', 'feature-factory/test-branch', 'feat: publish');

    expect(worktreeGit.raw).toHaveBeenNthCalledWith(1, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(worktreeGit.raw).toHaveBeenNthCalledWith(2, ['checkout', '-B', 'feature-factory/test-branch']);
    expect(worktreeGit.push).toHaveBeenCalledWith('origin', 'feature-factory/test-branch', ['--set-upstream']);
  });

  it('recreates a missing worktree by resetting the branch from origin/<base>', async () => {
    repoGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'prune') return '';
      if (args[0] === 'rev-parse') throw new Error('fatal: Needed a single revision');
      if (args[0] === 'worktree' && args[1] === 'add') return '';
      return '';
    });

    const workspace = new RepoWorkspace('/tmp/repo');

    await workspace.ensureWorktree(
      'feature-factory/test-branch',
      '/tmp/worktree',
      'main',
    );

    expect(repoGit.fetch).toHaveBeenCalledWith('origin');
    expect(repoGit.raw).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/heads/feature-factory/test-branch']);
    expect(repoGit.raw).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/remotes/origin/feature-factory/test-branch']);
    expect(repoGit.raw).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-B',
      'feature-factory/test-branch',
      '/tmp/worktree',
      'origin/main',
    ]);
  });

  it('reports uncommitted worktree changes via git status', async () => {
    worktreeGit.status.mockResolvedValueOnce({ files: [{ path: 'src/verbosity.ts' }] });

    const workspace = new RepoWorkspace('/tmp/repo');

    await expect(workspace.hasUncommittedChanges('/tmp/worktree')).resolves.toBe(true);
  });
});