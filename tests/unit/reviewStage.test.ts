import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReviewStage } from '../../src/stages/review';

describe('runReviewStage resume reuse', () => {
  it('reuses persisted review findings and fix output instead of calling models again', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-review-'));
    const runDir = path.join(tmpDir, 'ticket-1');
    fs.mkdirSync(runDir, { recursive: true });

    fs.writeFileSync(
      path.join(runDir, 'review-findings.json'),
      JSON.stringify([
        {
          severity: 'medium',
          summary: 'Fix this',
          actionable: true,
          file: 'src/foo.ts',
          line: 12,
        },
      ]),
    );
    fs.writeFileSync(
      path.join(runDir, 'review-fix.json'),
      JSON.stringify({
        summary: 'Applied the fix',
        fixesApplied: [{ finding: 'Fix this', action: 'Updated code', file: 'src/foo.ts' }],
      }),
    );

    const runner = {
      runReview: vi.fn(),
      runRole: vi.fn(),
    };
    const workspace = {
      getDiff: vi.fn().mockResolvedValue('diff --git a/src/foo.ts\n+const x = 1;'),
      commitAndPush: vi.fn().mockResolvedValue(undefined),
    };
    const validator = {
      run: vi.fn().mockResolvedValue([
        { passed: true, command: 'npm test', stdout: '', stderr: '', exitCode: 0 },
      ]),
    };
    const publisher = {
      addMilestone: vi.fn().mockResolvedValue(undefined),
    };
    const store = {
      runDir: vi.fn().mockReturnValue(runDir),
    };

    const result = await runReviewStage({
      config: { github: { defaultBranch: 'main' } } as never,
      store: store as never,
      runner: runner as never,
      workspace: workspace as never,
      validator: validator as never,
      publisher: publisher as never,
      ticketId: 'ticket-1',
      prNumber: 7,
      branch: 'feature/ticket-1',
      worktreeDir: '/tmp/worktree',
      openspecChangeDir: '/tmp/openspec',
      issueTitle: 'Issue',
    });

    expect(result).toBe('fixed');
    expect(runner.runReview).not.toHaveBeenCalled();
    expect(runner.runRole).not.toHaveBeenCalled();
    expect(workspace.commitAndPush).toHaveBeenCalledTimes(1);
    expect(publisher.addMilestone).toHaveBeenCalledTimes(1);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('uses the reviewer role for findings and the implementer role for bounded fixes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-review-'));
    const runDir = path.join(tmpDir, 'ticket-2');
    fs.mkdirSync(runDir, { recursive: true });

    const runner = {
      runReview: vi.fn().mockResolvedValue([
        {
          severity: 'warning',
          summary: 'Fix this',
          actionable: true,
          file: 'src/foo.ts',
          line: 12,
        },
      ]),
      runRole: vi.fn().mockResolvedValue(JSON.stringify({
        summary: 'Applied the fix',
        fixesApplied: [{ finding: 'Fix this', action: 'Updated code', file: 'src/foo.ts' }],
      })),
    };
    const workspace = {
      getDiff: vi.fn().mockResolvedValue('diff --git a/src/foo.ts\n+const x = 1;'),
      commitAndPush: vi.fn().mockResolvedValue(undefined),
    };
    const validator = {
      run: vi.fn().mockResolvedValue([
        { passed: true, command: 'npm test', stdout: '', stderr: '', exitCode: 0 },
      ]),
    };
    const publisher = {
      addMilestone: vi.fn().mockResolvedValue(undefined),
    };
    const store = {
      runDir: vi.fn().mockReturnValue(runDir),
    };

    const result = await runReviewStage({
      config: { github: { defaultBranch: 'main' } } as never,
      store: store as never,
      runner: runner as never,
      workspace: workspace as never,
      validator: validator as never,
      publisher: publisher as never,
      ticketId: 'ticket-2',
      prNumber: 8,
      branch: 'feature/ticket-2',
      worktreeDir: '/tmp/worktree',
      openspecChangeDir: '/tmp/openspec',
      issueTitle: 'Issue',
    });

    expect(result).toBe('fixed');
    expect(runner.runReview).toHaveBeenCalledTimes(1);
    expect(runner.runRole).toHaveBeenCalledWith(
      'implementer',
      expect.stringContaining('Review findings to fix'),
      'review-fix',
      'review',
      expect.objectContaining({ workingDirectory: '/tmp/worktree' }),
    );

    fs.rmSync(tmpDir, { recursive: true });
  });
});