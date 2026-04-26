import assert from 'assert';
import { describe, it } from 'mocha';
import { buildBranchName, buildDummyChangeContent, buildDummyFilePath } from '../activities';
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
    const gitCalls: GitCall[] = [];
    const { createWorktreeForIssueIfNeeded } = createActivityTestRig({
      worktree: {
        access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          return undefined;
        }
        throw createNotFoundError();
      },
        execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
        now: () => 123,
      },
    });

    const worktree = await createWorktreeForIssueIfNeeded({ issue });
    assert.deepStrictEqual(worktree, buildWorktreeContext(issue));
    assert.deepStrictEqual(gitCalls, []);
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

  it('preserves the dummy file writer in runDummyAgent', async () => {
    const worktree = buildWorktreeContext();
    const mkdirCalls: MkdirCall[] = [];
    const writeCalls: WriteCall[] = [];
    const { runDummyAgent } = createActivityTestRig({
      agent: {
        mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
        writeFile: async (targetPath, data, encoding) => {
        writeCalls.push({ path: String(targetPath), data, encoding });
      },
      },
    });

    await runDummyAgent({ worktree });

    assert.deepStrictEqual(mkdirCalls, [
      { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7/orchestrator-runs', options: { recursive: true } },
    ]);
    assert.deepStrictEqual(writeCalls, [
      {
        path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7/orchestrator-runs/issue-7.md',
        data: buildDummyChangeContent(7, 'Create a dummy PR', '1970-01-01T00:00:00.123Z'),
        encoding: 'utf8',
      },
    ]);
  });

  it('stages, commits, and pushes the worktree changes', async () => {
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

  it('builds deterministic worktree helper values', () => {
    assert.strictEqual(buildBranchName(9, 'auto'), 'auto/issue-9');
    assert.strictEqual(buildDummyFilePath(9, 'runs'), 'runs/issue-9.md');
    assert.strictEqual(
      buildDummyChangeContent(9, 'Ship Dummy Automation!', '2026-04-26T00:00:00.000Z'),
      ['# Orchestrator Dummy Change', '', '- Issue: #9', '- Title: Ship Dummy Automation!', '- Generated at: 2026-04-26T00:00:00.000Z'].join('\n'),
    );
  });
});