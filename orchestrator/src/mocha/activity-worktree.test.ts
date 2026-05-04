import assert from 'assert';
import { describe, it } from 'mocha';
import type { WorktreeActivityDeps } from '../activity-deps';
import { buildBranchName } from '../activities';
import {
  type AppendCall,
  type GitCall,
  type MkdirCall,
  type WriteCall,
  buildSelectedIssue,
  buildWorktreeContext,
  createActivityTestRig,
  createNotFoundError,
} from './activity-test-helpers';

describe('worktree activities', () => {
  it('creates a stable worktree context after local git preparation', async () => {
    const issue = buildSelectedIssue();
    const expectedWorktree = buildWorktreeContext(issue);
    const gitCalls: GitCall[] = [];
    const mkdirCalls: MkdirCall[] = [];
    const { repoRoot, worktreePath } = expectedWorktree;
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath === repoRoot || targetPath === worktreePath) {
          throw createNotFoundError();
        }
      },
        mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    const worktree = await createWorktreeForIssueIfNeeded({ issue });

    assert.deepStrictEqual(worktree, expectedWorktree);
    assert.deepStrictEqual(gitCalls, [
      { cwd: '/tmp/orchestrator/Mugenor', args: ['clone', 'https://github.com/Mugenor/orchestrator-testing.git', repoRoot] },
      { cwd: repoRoot, args: ['check-ignore', '.worktrees'] },
      { cwd: repoRoot, args: ['checkout', '-B', 'main', 'origin/main'] },
      { cwd: repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', 'orchestrator/issue-7'] },
      { cwd: repoRoot, args: ['worktree', 'add', '-b', 'orchestrator/issue-7', worktreePath, 'origin/main'] },
    ]);
    assert.deepStrictEqual(mkdirCalls, [
      { path: '/tmp/orchestrator/Mugenor', options: { recursive: true } },
      { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees', options: { recursive: true } },
    ]);
  });

  it('reuses an existing clone by fetching before creating the worktree', async () => {
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          throw createNotFoundError();
        }
      },
        mkdir: async () => undefined,
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });
    assert.deepStrictEqual(gitCalls[0], {
      cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
      args: ['fetch', '--prune', 'origin'],
    });
  });

  it('returns the existing worktree context when the issue worktree is already present', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          return undefined;
        }
        throw createNotFoundError();
      },
        realpath: (async (targetPath) => String(targetPath)) as WorktreeActivityDeps['realpath'],
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'rev-parse') {
          return { stdout: `${worktree.worktreePath}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    const existingWorktree = await createWorktreeForIssueIfNeeded({ issue });
    assert.deepStrictEqual(existingWorktree, worktree);
    assert.deepStrictEqual(gitCalls, [{ cwd: worktree.worktreePath, args: ['rev-parse', '--show-toplevel'] }]);
  });

  it('recreates a corrupt existing issue worktree instead of trusting the directory', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
          if (targetPath === worktree.repoRoot || targetPath === worktree.worktreePath) {
            return undefined;
          }
          throw createNotFoundError();
        },
        realpath: (async (targetPath) => String(targetPath)) as WorktreeActivityDeps['realpath'],
        mkdir: async () => undefined,
        rm: async () => undefined,
        execFile: async (_file, args, options) => {
          gitCalls.push({ args, cwd: options?.cwd });
          if (args[0] === 'rev-parse') {
            throw new Error('not a git worktree');
          }
          if (args[0] === 'check-ignore') {
            return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'ls-remote') {
            return { stdout: '', stderr: '', exitCode: 2 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        now: () => 123,
      },
    });

    const recreatedWorktree = await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });

    assert.deepStrictEqual(recreatedWorktree, worktree);
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['rev-parse', '--show-toplevel'] },
      { cwd: worktree.repoRoot, args: ['fetch', '--prune', 'origin'] },
      { cwd: worktree.repoRoot, args: ['check-ignore', '.worktrees'] },
      { cwd: worktree.repoRoot, args: ['checkout', '-B', 'main', 'origin/main'] },
      { cwd: worktree.repoRoot, args: ['worktree', 'remove', '--force', worktree.worktreePath] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'add', '-b', worktree.branchName, worktree.worktreePath, 'origin/main'] },
    ]);
  });

  it('recovers from a corrupt worktree even when git cleanup metadata is already missing', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const rmCalls: string[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
          if (targetPath === worktree.repoRoot || targetPath === worktree.worktreePath) {
            return undefined;
          }
          throw createNotFoundError();
        },
        realpath: (async (targetPath) => String(targetPath)) as WorktreeActivityDeps['realpath'],
        mkdir: async () => undefined,
        rm: async (targetPath) => {
          rmCalls.push(String(targetPath));
        },
        execFile: async (_file, args, options) => {
          gitCalls.push({ args, cwd: options?.cwd });
          if (args[0] === 'rev-parse') {
            throw new Error('not a git worktree');
          }
          if (args[0] === 'check-ignore') {
            return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'worktree' && args[1] === 'remove') {
            throw new Error('git worktree remove failed in /tmp/orchestrator: not a working tree');
          }
          if (args[0] === 'branch' && args[1] === '-D') {
            throw new Error(`git branch -D ${worktree.branchName} failed in /tmp/orchestrator: branch not found`);
          }
          if (args[0] === 'ls-remote') {
            return { stdout: '', stderr: '', exitCode: 2 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        now: () => 123,
      },
    });

    const recreatedWorktree = await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });

    assert.deepStrictEqual(recreatedWorktree, worktree);
    assert.deepStrictEqual(rmCalls, [worktree.worktreePath]);
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['rev-parse', '--show-toplevel'] },
      { cwd: worktree.repoRoot, args: ['fetch', '--prune', 'origin'] },
      { cwd: worktree.repoRoot, args: ['check-ignore', '.worktrees'] },
      { cwd: worktree.repoRoot, args: ['checkout', '-B', 'main', 'origin/main'] },
      { cwd: worktree.repoRoot, args: ['worktree', 'remove', '--force', worktree.worktreePath] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'add', '-b', worktree.branchName, worktree.worktreePath, 'origin/main'] },
    ]);
  });

  it('prunes stale worktree registrations before retrying branch deletion during corrupt recovery', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const rmCalls: string[] = [];
    let branchDeleteAttempts = 0;
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
          if (targetPath === worktree.repoRoot || targetPath === worktree.worktreePath) {
            return undefined;
          }
          throw createNotFoundError();
        },
        realpath: (async (targetPath) => String(targetPath)) as WorktreeActivityDeps['realpath'],
        mkdir: async () => undefined,
        rm: async (targetPath) => {
          rmCalls.push(String(targetPath));
        },
        execFile: async (_file, args, options) => {
          gitCalls.push({ args, cwd: options?.cwd });
          if (args[0] === 'rev-parse') {
            throw new Error('not a git worktree');
          }
          if (args[0] === 'check-ignore') {
            return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'worktree' && args[1] === 'remove') {
            throw new Error('git worktree remove failed in /tmp/orchestrator: not a working tree');
          }
          if (args[0] === 'branch' && args[1] === '-D') {
            branchDeleteAttempts += 1;
            if (branchDeleteAttempts === 1) {
              throw new Error(`git branch -D ${worktree.branchName} failed in /tmp/orchestrator: cannot delete branch '${worktree.branchName}' used by worktree at '${worktree.worktreePath}'`);
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'ls-remote') {
            return { stdout: '', stderr: '', exitCode: 2 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        now: () => 123,
      },
    });

    const recreatedWorktree = await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });

    assert.deepStrictEqual(recreatedWorktree, worktree);
    assert.deepStrictEqual(rmCalls, [worktree.worktreePath]);
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['rev-parse', '--show-toplevel'] },
      { cwd: worktree.repoRoot, args: ['fetch', '--prune', 'origin'] },
      { cwd: worktree.repoRoot, args: ['check-ignore', '.worktrees'] },
      { cwd: worktree.repoRoot, args: ['checkout', '-B', 'main', 'origin/main'] },
      { cwd: worktree.repoRoot, args: ['worktree', 'remove', '--force', worktree.worktreePath] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'prune'] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'add', '-b', worktree.branchName, worktree.worktreePath, 'origin/main'] },
    ]);
  });

  it('recovers stale git worktree registrations even when the worktree directory is already gone', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const rmCalls: string[] = [];
    let addAttempts = 0;
    let branchDeleteAttempts = 0;
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
          if (targetPath === worktree.repoRoot) {
            return undefined;
          }
          throw createNotFoundError();
        },
        realpath: (async (targetPath) => String(targetPath)) as WorktreeActivityDeps['realpath'],
        mkdir: async () => undefined,
        rm: async (targetPath) => {
          rmCalls.push(String(targetPath));
        },
        execFile: async (_file, args, options) => {
          gitCalls.push({ args, cwd: options?.cwd });
          if (args[0] === 'check-ignore') {
            return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'ls-remote') {
            return { stdout: '', stderr: '', exitCode: 2 };
          }
          if (args[0] === 'worktree' && args[1] === 'add') {
            addAttempts += 1;
            if (addAttempts === 1) {
              throw new Error(`git worktree add failed in ${worktree.repoRoot}: branch '${worktree.branchName}' is already checked out at '${worktree.worktreePath}'`);
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'worktree' && args[1] === 'remove') {
            throw new Error('git worktree remove failed in /tmp/orchestrator: not a working tree');
          }
          if (args[0] === 'branch' && args[1] === '-D') {
            branchDeleteAttempts += 1;
            if (branchDeleteAttempts === 1) {
              throw new Error(`git branch -D ${worktree.branchName} failed in /tmp/orchestrator: cannot delete branch '${worktree.branchName}' used by worktree at '${worktree.worktreePath}'`);
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        now: () => 123,
      },
    });

    const recreatedWorktree = await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });

    assert.deepStrictEqual(recreatedWorktree, worktree);
    assert.deepStrictEqual(rmCalls, [worktree.worktreePath]);
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.repoRoot, args: ['fetch', '--prune', 'origin'] },
      { cwd: worktree.repoRoot, args: ['check-ignore', '.worktrees'] },
      { cwd: worktree.repoRoot, args: ['checkout', '-B', 'main', 'origin/main'] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'add', '-b', worktree.branchName, worktree.worktreePath, 'origin/main'] },
      { cwd: worktree.repoRoot, args: ['worktree', 'remove', '--force', worktree.worktreePath] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'prune'] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.repoRoot, args: ['worktree', 'add', '-b', worktree.branchName, worktree.worktreePath, 'origin/main'] },
    ]);
  });

  it('treats realpath-equivalent /tmp and /private/tmp worktrees as healthy', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
          if (targetPath === worktree.worktreePath) {
            return undefined;
          }
          throw createNotFoundError();
        },
        realpath: (async (targetPath) => {
          const value = String(targetPath);
          return value.startsWith('/tmp/') ? value.replace('/tmp/', '/private/tmp/') : value;
        }) as WorktreeActivityDeps['realpath'],
        execFile: async (_file, args, options) => {
          gitCalls.push({ args, cwd: options?.cwd });
          if (args[0] === 'rev-parse') {
            return {
              stdout: `${worktree.worktreePath.replace('/tmp/', '/private/tmp/')}\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        now: () => 123,
      },
    });

    const existingWorktree = await createWorktreeForIssueIfNeeded({ issue });

    assert.deepStrictEqual(existingWorktree, worktree);
    assert.deepStrictEqual(gitCalls, [{ cwd: worktree.worktreePath, args: ['rev-parse', '--show-toplevel'] }]);
  });

  it('adds .worktrees to the local info exclude when it is not already ignored', async () => {
    const gitCalls: GitCall[] = [];
    const appendCalls: AppendCall[] = [];
    const mkdirCalls: MkdirCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          throw createNotFoundError();
        }
      },
        mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
        appendFile: async (targetPath, data, encoding) => {
        appendCalls.push({ path: targetPath, data, encoding });
      },
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    const worktree = await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });

    assert.deepStrictEqual(worktree, buildWorktreeContext());
    assert.deepStrictEqual(gitCalls[0], { cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing', args: ['fetch', '--prune', 'origin'] });
    assert.deepStrictEqual(mkdirCalls, [
      { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.git/info', options: { recursive: true } },
      { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees', options: { recursive: true } },
    ]);
    assert.deepStrictEqual(appendCalls, [
      { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.git/info/exclude', data: '.worktrees/\n', encoding: 'utf8' },
    ]);
  });

  it('recreates the local worktree from the remote issue branch when it already exists', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath === worktree.worktreePath) {
          throw createNotFoundError();
        }
      },
        mkdir: async () => undefined,
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: `abc\t${worktree.branchName}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    await createWorktreeForIssueIfNeeded({ issue: buildSelectedIssue() });
    assert.deepStrictEqual(gitCalls.at(-1), {
      cwd: worktree.repoRoot,
      args: ['worktree', 'add', '-B', worktree.branchName, worktree.worktreePath, `origin/${worktree.branchName}`],
    });
  });

  it('stages, commits, and pushes the worktree changes without force', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { commitAndPush } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '', exitCode: 2 };
        if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await commitAndPush({ worktree });
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['add', '--all'] },
      { cwd: worktree.worktreePath, args: ['diff', '--cached', '--quiet', '--exit-code'] },
      { cwd: worktree.worktreePath, args: ['commit', '-m', `Add dummy change for issue #${worktree.issueNumber}`] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.worktreePath, args: ['rev-list', '--count', `origin/${worktree.defaultBranch}..HEAD`] },
      { cwd: worktree.worktreePath, args: ['push', '-u', 'origin', worktree.branchName] },
    ]);
  });

  it('uses the agent-provided commit message when committing staged changes', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { commitAndPush } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '', exitCode: 2 };
        if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await commitAndPush({ worktree, commitMessage: 'feat: generate metadata from Codex' });
    assert.strictEqual(gitCalls[2].args[2], 'feat: generate metadata from Codex');
  });

  it('skips commit but still pushes when commitAndPush is retried with an unpushed local commit', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { commitAndPush } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '', exitCode: 2 };
        if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '', exitCode: 0 };
        if (args[0] === 'commit') throw new Error('commit should be skipped when nothing is staged');
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await commitAndPush({ worktree });
    assert.ok(gitCalls.every((call) => call.args[0] !== 'commit'));
    assert.deepStrictEqual(gitCalls.at(-1), { cwd: worktree.worktreePath, args: ['push', '-u', 'origin', worktree.branchName] });
  });

  it('treats an already-pushed branch as a successful retry replay', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { commitAndPush } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
        if (args[0] === 'ls-remote') return { stdout: 'refs/heads/orchestrator/issue-7\n', stderr: '', exitCode: 0 };
        if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '', exitCode: 0 };
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        if (args[0] === 'push') throw new Error('push should be skipped when the branch is already at HEAD');
        if (args[0] === 'commit') throw new Error('commit should be skipped when nothing is staged');
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await commitAndPush({ worktree });

    assert.ok(gitCalls.every((call) => call.args[0] !== 'commit'));
    assert.ok(gitCalls.every((call) => call.args[0] !== 'push'));
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['add', '--all'] },
      { cwd: worktree.worktreePath, args: ['diff', '--cached', '--quiet', '--exit-code'] },
      { cwd: worktree.repoRoot, args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName] },
      { cwd: worktree.worktreePath, args: ['rev-list', '--count', `origin/${worktree.branchName}..HEAD`] },
      { cwd: worktree.worktreePath, args: ['rev-parse', 'HEAD'] },
      { cwd: worktree.worktreePath, args: ['rev-parse', `origin/${worktree.branchName}`] },
    ]);
  });

  it('fails instead of pushing an unchanged branch when the agent produced no diff', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { commitAndPush } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '', exitCode: 2 };
        if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '', exitCode: 0 };
        if (args[0] === 'push') throw new Error('push should be skipped when there are no commits to publish');
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await assert.rejects(() => commitAndPush({ worktree }), /produced no changes to push/);
    assert.ok(gitCalls.every((call) => call.args[0] !== 'push'));
  });

  it('removes the local worktree and branch during cleanup', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { cleanupWorktree } = createActivityTestRig({
      worktree: { execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await cleanupWorktree({ worktree });
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.repoRoot, args: ['worktree', 'remove', '--force', worktree.worktreePath] },
      { cwd: worktree.repoRoot, args: ['branch', '-D', worktree.branchName] },
    ]);
  });

  it('reads OpenSpec draft files relative to the change root', async () => {
    const worktree = buildWorktreeContext();
    const { readOpenSpecChangeFiles } = createActivityTestRig({
      worktree: {
        access: async () => undefined,
        readdir: async (targetPath) => String(targetPath).endsWith('/specs')
          ? [{ name: 'demo', isDirectory: () => true, isFile: () => false } as any]
          : String(targetPath).endsWith('/demo')
            ? [{ name: 'spec.md', isDirectory: () => false, isFile: () => true } as any]
            : [
                { name: 'proposal.md', isDirectory: () => false, isFile: () => true } as any,
                { name: 'specs', isDirectory: () => true, isFile: () => false } as any,
              ],
        readFile: async (targetPath, _encoding: any) => String(targetPath).endsWith('proposal.md') ? '# Proposal' as any : '## ADDED Requirements' as any,
      },
    });

    const files = await readOpenSpecChangeFiles({ worktree, changeName: '7-demo-change' });
    assert.deepStrictEqual(files, [
      { path: 'proposal.md', content: '# Proposal' },
      { path: 'specs/demo/spec.md', content: '## ADDED Requirements' },
    ]);
  });

  it('writes OpenSpec draft files under the change root', async () => {
    const worktree = buildWorktreeContext();
    const mkdirCalls: MkdirCall[] = [];
    const writeCalls: WriteCall[] = [];
    const { writeOpenSpecChangeFiles } = createActivityTestRig({
      worktree: {
        mkdir: async (targetPath, options) => {
          mkdirCalls.push({ path: String(targetPath), options });
          return undefined;
        },
        writeFile: async (targetPath, data, encoding) => {
          writeCalls.push({ path: String(targetPath), data, encoding });
        },
      },
    });

    await writeOpenSpecChangeFiles({
      worktree,
      changeName: '7-demo-change',
      files: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'specs/demo/spec.md', content: '## ADDED Requirements' },
      ],
    });

    assert.deepStrictEqual(mkdirCalls, [
      { path: `${worktree.worktreePath}/openspec/changes/7-demo-change`, options: { recursive: true } },
      { path: `${worktree.worktreePath}/openspec/changes/7-demo-change/specs/demo`, options: { recursive: true } },
    ]);
    assert.deepStrictEqual(writeCalls, [
      { path: `${worktree.worktreePath}/openspec/changes/7-demo-change/proposal.md`, data: '# Proposal', encoding: 'utf8' },
      { path: `${worktree.worktreePath}/openspec/changes/7-demo-change/specs/demo/spec.md`, data: '## ADDED Requirements', encoding: 'utf8' },
    ]);
  });

  it('writes repository files under the worktree root', async () => {
    const worktree = buildWorktreeContext();
    const mkdirCalls: MkdirCall[] = [];
    const writeCalls: WriteCall[] = [];
    const { writeRepositoryFiles } = createActivityTestRig({
      worktree: {
        mkdir: async (targetPath, options) => {
          mkdirCalls.push({ path: String(targetPath), options });
          return undefined;
        },
        writeFile: async (targetPath, data, encoding) => {
          writeCalls.push({ path: String(targetPath), data, encoding });
        },
      },
    });

    await writeRepositoryFiles({
      worktree,
      files: [
        { path: 'src/index.ts', content: 'export const ok = true;\n' },
        { path: 'docs/summary.md', content: '# Summary' },
      ],
    });

    assert.deepStrictEqual(mkdirCalls, [
      { path: `${worktree.worktreePath}/src`, options: { recursive: true } },
      { path: `${worktree.worktreePath}/docs`, options: { recursive: true } },
    ]);
    assert.deepStrictEqual(writeCalls, [
      { path: `${worktree.worktreePath}/src/index.ts`, data: 'export const ok = true;\n', encoding: 'utf8' },
      { path: `${worktree.worktreePath}/docs/summary.md`, data: '# Summary', encoding: 'utf8' },
    ]);
  });

  it('runs openspec validate from the worktree root', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { validateOpenSpecChange } = createActivityTestRig({
      worktree: { execFile: async (file, args, options) => {
        gitCalls.push({ cwd: options?.cwd, args: [String(file), ...args] });
        return { stdout: '', stderr: '', exitCode: 0 };
      } },
    });

    await validateOpenSpecChange({ worktree, changeName: '7-demo-change' });
    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['openspec', 'validate', '7-demo-change', '--strict'] },
    ]);
  });

  it('runs make check when the worktree Makefile declares a check target', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const longLog = 'x'.repeat(5000);
    const { runQualityGate } = createActivityTestRig({
      worktree: {
        access: async (targetPath) => {
          if (String(targetPath) === `${worktree.worktreePath}/Makefile`) {
            return undefined;
          }
          throw createNotFoundError();
        },
        readFile: async () => 'check:\n\t@echo ok\n' as any,
        execFile: async (file, args, options) => {
          gitCalls.push({ cwd: options?.cwd, args: [String(file), ...args] });
          return { stdout: longLog, stderr: 'tail', exitCode: 1 };
        },
      },
    });

    const result = await runQualityGate({ worktree, qualityGates: [] });

    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['make', 'check'] },
    ]);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.summary, 'make check failed');
    assert.match(result.logs, /tail|\.\.\.\[truncated\]/);
    assert.ok(result.logs.length < 4200);
  });

  it('falls back to npm run check when package.json declares a check script', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const { runQualityGate } = createActivityTestRig({
      worktree: {
        access: async (targetPath) => {
          const value = String(targetPath);
          if (value === `${worktree.worktreePath}/Makefile` || value === `${worktree.worktreePath}/package.json`) {
            return undefined;
          }
          throw createNotFoundError();
        },
        readFile: async (targetPath) => {
          if (String(targetPath).endsWith('/Makefile')) {
            return 'build:\n\t@echo build\n' as any;
          }
          return JSON.stringify({ scripts: { check: 'slidev export --dry-run' } }) as any;
        },
        execFile: async (file, args, options) => {
          gitCalls.push({ cwd: options?.cwd, args: [String(file), ...args] });
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        },
      },
    });

    const result = await runQualityGate({ worktree, qualityGates: [] });

    assert.deepStrictEqual(gitCalls, [
      { cwd: worktree.worktreePath, args: ['npm', 'run', 'check'] },
    ]);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.summary, 'npm run check passed');
    assert.strictEqual(result.logs, 'ok');
  });

  it('treats repositories without a declared quality gate as passing', async () => {
    const worktree = buildWorktreeContext();
    const { runQualityGate } = createActivityTestRig({
      worktree: {
        access: async () => {
          throw createNotFoundError();
        },
      },
    });

    const result = await runQualityGate({ worktree, qualityGates: [] });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.summary, 'no quality gate configured');
    assert.strictEqual(result.logs, '');
  });

  it('runs explicit project extension quality gates via zsh -c in manifest order', async () => {
    const worktree = buildWorktreeContext();
    const gateCalls: GitCall[] = [];
    const { runQualityGate } = createActivityTestRig({
      worktree: {
        access: async () => { throw new Error('fallback detection should not run when explicit quality gates are provided'); },
        readFile: async () => { throw new Error('fallback detection should not read repo files when explicit quality gates are provided'); },
        execFile: async (file, args, options) => {
          gateCalls.push({ cwd: options?.cwd, args: [String(file), ...args] });
          const command = args[1];
          return { stdout: `${command} ok`, stderr: '', exitCode: 0 };
        },
      },
    });

    const result = await runQualityGate({
      worktree,
      qualityGates: [
        { id: 'lint', run: 'pnpm lint' },
        { id: 'test', run: 'pnpm test -- --runInBand' },
      ],
    });

    assert.deepStrictEqual(gateCalls, [
      { cwd: worktree.worktreePath, args: ['zsh', '-c', 'pnpm lint'] },
      { cwd: worktree.worktreePath, args: ['zsh', '-c', 'pnpm test -- --runInBand'] },
    ]);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.summary, 'quality gates passed: lint, test');
    assert.match(result.logs, /pnpm lint ok/);
    assert.match(result.logs, /pnpm test -- --runInBand ok/);
  });

  it('fails on the first explicit project extension quality gate and skips fallback commands', async () => {
    const worktree = buildWorktreeContext();
    const gateCalls: GitCall[] = [];
    const { runQualityGate } = createActivityTestRig({
      worktree: {
        access: async () => { throw new Error('fallback detection should not run when explicit quality gates are provided'); },
        readFile: async () => { throw new Error('fallback detection should not read repo files when explicit quality gates are provided'); },
        execFile: async (file, args, options) => {
          gateCalls.push({ cwd: options?.cwd, args: [String(file), ...args] });
          return { stdout: '', stderr: 'src/index.ts(1,1): error TS1005', exitCode: 1 };
        },
      },
    });

    const result = await runQualityGate({
      worktree,
      qualityGates: [{ id: 'typecheck', run: 'pnpm typecheck' }],
    });

    assert.deepStrictEqual(gateCalls, [
      { cwd: worktree.worktreePath, args: ['zsh', '-c', 'pnpm typecheck'] },
    ]);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.summary, 'quality gate failed: typecheck');
    assert.match(result.logs, /src\/index\.ts\(1,1\): error TS1005/);
  });

  it('builds deterministic worktree helper values', () => {
    assert.strictEqual(buildBranchName(9, 'auto'), 'auto/issue-9');
  });
});
