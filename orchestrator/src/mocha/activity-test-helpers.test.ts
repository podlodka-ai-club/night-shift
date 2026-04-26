import assert from 'assert';
import { Context } from '@temporalio/activity';
import { describe, it } from 'mocha';
import {
  TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX,
  buildSelectedIssue,
  buildWorktreeContext,
  createActivityTestRig,
} from './activity-test-helpers';

describe('activity test rig defaults', () => {
  it('fails fast when a test forgets to mock GitHub fetch', async () => {
    const { getTopReadyIssue } = createActivityTestRig();

    await assert.rejects(
      () => getTopReadyIssue({ projectOwner: buildSelectedIssue().repoOwner, projectNumber: 1 }),
      (error: unknown) => error instanceof Error && error.message.includes(TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX) && error.message.includes('github.fetch'),
    );
  });

  it('fails fast when a test forgets to mock worktree command execution', async () => {
    const { commitAndPush } = createActivityTestRig();

    await assert.rejects(
      () => commitAndPush({ worktree: buildWorktreeContext() }),
      (error: unknown) => error instanceof Error && error.message.includes(TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX) && error.message.includes('worktree.execFile'),
    );
  });

  it('fails fast when a test forgets to mock filesystem writes', async () => {
    const { runDummyAgent } = createActivityTestRig();

    await assert.rejects(
      () => runDummyAgent({ worktree: buildWorktreeContext() }),
      (error: unknown) => error instanceof Error && error.message.includes(TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX) && error.message.includes('agent.mkdir'),
    );
  });

  it('fails fast when a test forgets to mock Codex thread creation', async () => {
    const { runAgentSequence } = createActivityTestRig();

    await assert.rejects(
      () =>
        runAgentSequence({
          worktree: buildWorktreeContext(),
          steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }],
        }),
      (error: unknown) => error instanceof Error && error.message.includes(TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX) && error.message.includes('agent.createCodexThread'),
    );
  });

  it('does not depend on Context.current for default agent context behavior', async () => {
    const originalCurrent = Context.current;
    Context.current = (() => {
      throw new Error('unexpected global activity context access');
    }) as typeof Context.current;

    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async () => ({ finalResponse: 'Implemented the requested change.' }),
        }),
      },
    });

    try {
      const result = await runAgentSequence({
        worktree: buildWorktreeContext(),
        steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }],
      });

      assert.strictEqual(result.threadId, 'thread-123');
      assert.deepStrictEqual(result.completedStepIds, ['edit']);
    } finally {
      Context.current = originalCurrent;
    }
  });
});