import assert from 'assert';
import path from 'node:path';
import { describe, it } from 'mocha';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER } from '../agent-provider';
import { createDefaultLiveTurnRunner } from '../eval/live-common';

describe('default live turn runner', () => {
  it('uses structured-output repair so live eval matches the current structured turn path', async () => {
    const prompts: string[] = [];
    const sessionPaths: string[] = [];
    const runner = createDefaultLiveTurnRunner({
      createSession: (worktreePath: string) => {
        sessionPaths.push(worktreePath);
        return {
          id: 'thread-123',
          run: async (prompt: string) => {
            prompts.push(prompt);
            return prompts.length === 1
              ? {
                  finalResponse: '{"ok":42}',
                  usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 3 },
                  costMicroUsd: 100,
                }
              : {
                  finalResponse: '{"ok":true}',
                  usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 4 },
                  costMicroUsd: 50,
                };
          },
        };
      },
      heartbeat: () => undefined,
      getCancellationSignal: () => undefined,
    });

    const result = await runner({
      worktreePath: './tmp/live-eval-repo',
      prompt: 'Return structured JSON only.',
      outputSchema: { type: 'object' },
      parseOutput: (value: unknown) => {
        const parsed = value as { ok?: unknown };
        if (typeof parsed?.ok !== 'boolean') {
          throw new Error('ok must be boolean');
        }
        return parsed;
      },
    });

    assert.deepStrictEqual(sessionPaths, [path.resolve('./tmp/live-eval-repo')]);
    assert.strictEqual(prompts.length, 2);
    assert.match(prompts[1] ?? '', /previous response did not satisfy/i);
    assert.strictEqual(result.finalText, '{"ok":true}');
    assert.deepStrictEqual(result.usage, { input_tokens: 18, cached_input_tokens: 2, output_tokens: 7 });
    assert.strictEqual(result.costMicroUsd, 150);
  });

  it('reuses the same cancellation signal in the fallback path', async () => {
    let signalCalls = 0;
    const signal = new AbortController().signal;
    let observedSignal: AbortSignal | undefined;
    const runner = createDefaultLiveTurnRunner({
      createSession: () => ({
        id: 'thread-456',
        run: async (_prompt: string, options?: { signal?: AbortSignal }) => {
          observedSignal = options?.signal;
          return { finalResponse: 'plain text response' };
        },
      }),
      heartbeat: () => undefined,
      getCancellationSignal: () => {
        signalCalls += 1;
        return signal;
      },
    });

    const result = await runner({
      worktreePath: './tmp/live-eval-repo',
      prompt: 'Return plain text only.',
    });

    assert.strictEqual(signalCalls, 1);
    assert.strictEqual(observedSignal, signal);
    assert.strictEqual(result.finalText, 'plain text response');
  });

  it('resolves the shared default provider selection when live requests omit provider details', async () => {
    const sessionCalls: Array<{ worktreePath: string; selection: { provider: string; model: string } }> = [];
    const runner = createDefaultLiveTurnRunner({
      createSession: (worktreePath: string, selection) => {
        sessionCalls.push({ worktreePath, selection });
        return {
          id: 'thread-default',
          run: async () => ({ finalResponse: 'plain text response' }),
        };
      },
      heartbeat: () => undefined,
      getCancellationSignal: () => undefined,
    });

    await runner({
      worktreePath: './tmp/live-eval-repo',
      prompt: 'Return plain text only.',
    });

    assert.deepStrictEqual(sessionCalls, [{
      worktreePath: path.resolve('./tmp/live-eval-repo'),
      selection: { provider: 'codex', model: DEFAULT_AGENT_MODEL_BY_PROVIDER.codex },
    }]);
  });
});