import assert from 'assert';
import path from 'node:path';
import { describe, it } from 'mocha';
import { createActivityDependencies } from '../activities';
import { createCodexAgentAdapter, createLazyCodexSession } from '../activity-deps';

describe('activity dependencies', () => {
  it('closes stdin for child commands in the default command runner', async () => {
    const orchestratorRoot = path.resolve(__dirname, '..', '..');
    const result = await createActivityDependencies().execFile(
      'node',
      [
        '-e',
        [
          "process.stdin.once('end', () => {",
          "  console.log('stdin-closed');",
          '  process.exit(0);',
          '});',
          "process.stdin.resume();",
          'setTimeout(() => {',
          "  console.error('stdin-still-open');",
          '  process.exit(7);',
          '}, 100);',
        ].join(' '),
      ],
      { cwd: orchestratorRoot },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /stdin-closed/);
  });

  it('creates and resumes sessions through the Codex adapter boundary', async () => {
    const createCalls: string[] = [];
    const resumeCalls: Array<{ worktreePath: string; threadId: string }> = [];
    const createdSession = { id: 'created-thread', run: async () => ({ finalResponse: 'created' }) };
    const resumedSession = { id: 'resumed-thread', run: async () => ({ finalResponse: 'resumed' }) };
    const adapter = createCodexAgentAdapter({
      createCodexThread(worktreePath: string) {
        createCalls.push(worktreePath);
        return createdSession;
      },
      resumeCodexThread(worktreePath: string, threadId: string) {
        resumeCalls.push({ worktreePath, threadId });
        return resumedSession;
      },
    });

    assert.strictEqual(adapter.createSession('/tmp/worktree'), createdSession);
    assert.strictEqual(adapter.resumeSession('/tmp/worktree', 'thread-123'), resumedSession);
    assert.deepStrictEqual(createCalls, ['/tmp/worktree']);
    assert.deepStrictEqual(resumeCalls, [{ worktreePath: '/tmp/worktree', threadId: 'thread-123' }]);
  });

  it('keeps lazy session identity, passes schema and signal through, and forwards progress events', async () => {
    const abortController = new AbortController();
    const runCalls: Array<{ prompt: string; options?: unknown }> = [];
    const progressEvents: unknown[] = [];
    const session = createLazyCodexSession('startThread', async () => ({
      id: 'thread-123',
      async run(prompt: string, options?: unknown) {
        runCalls.push({ prompt, options });
        return {
          finalResponse: '{"ok":true}',
          items: [{ type: 'message.delta', text: 'working' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    }));

    assert.strictEqual(session.id, null);
    const result = await session.run('Return JSON', {
      outputSchema: { type: 'object' },
      signal: abortController.signal,
      onEvent: (event) => progressEvents.push(event),
    });

    assert.strictEqual(session.id, 'thread-123');
    assert.strictEqual(result.finalResponse, '{"ok":true}');
    assert.deepStrictEqual(progressEvents, [
      { type: 'provider-item', payload: { type: 'message.delta', text: 'working' } },
      { type: 'usage', payload: { inputTokens: 10, outputTokens: 5 } },
    ]);
    assert.deepStrictEqual(runCalls, [{
      prompt: 'Return JSON',
      options: { outputSchema: { type: 'object' }, signal: abortController.signal, onEvent: runCalls[0]?.options && (runCalls[0] as { options: { onEvent?: unknown } }).options.onEvent },
    }]);
  });
});