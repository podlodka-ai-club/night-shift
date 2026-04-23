import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runImplementStage } from '../../src/stages/implement';

describe('runImplementStage', () => {
  it('rejects implementer no-op results instead of treating them as success', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-implement-stage-'));
    const changeDir = path.join(tempRoot, 'change');
    const worktreeDir = path.join(tempRoot, 'worktree');
    const runDir = path.join(tempRoot, 'run');
    fs.mkdirSync(changeDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [ ] Add verbosity controls\n');

    const store = {
      runDir: () => runDir,
    };
    const runner = {
      runRole: async () => JSON.stringify({
        completed: false,
        summary: 'Sandbox was read-only so no changes were made.',
        filesChanged: ['None (read-only sandbox)'],
        tasksCompleted: ['None (blocked by read-only filesystem)'],
      }),
    };

    await expect(runImplementStage({
      config: {} as never,
      store: store as never,
      runner: runner as never,
      ticketId: 'ticket-1',
      openspecChangeDir: changeDir,
      worktreeDir,
      issueTitle: 'Verbosity levels',
    })).rejects.toThrow('Refusing to treat the run as implemented');

    expect(fs.existsSync(path.join(runDir, 'implement-error.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'implement-summary.json'))).toBe(false);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('requires the implementer to explicitly mark successful completion', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-implement-stage-'));
    const changeDir = path.join(tempRoot, 'change');
    const worktreeDir = path.join(tempRoot, 'worktree');
    const runDir = path.join(tempRoot, 'run');
    fs.mkdirSync(changeDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [ ] Add verbosity controls\n');

    const store = {
      runDir: () => runDir,
    };
    const runner = {
      runRole: async () => JSON.stringify({
        completed: true,
        summary: 'Implemented verbosity scaffolding.',
        filesChanged: ['src/verbosity.ts'],
        tasksCompleted: ['1.1 Add VerbosityLevel type'],
      }),
    };

    await expect(runImplementStage({
      config: {} as never,
      store: store as never,
      runner: runner as never,
      ticketId: 'ticket-1',
      openspecChangeDir: changeDir,
      worktreeDir,
      issueTitle: 'Verbosity levels',
    })).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(runDir, 'implement-summary.json'))).toBe(true);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});