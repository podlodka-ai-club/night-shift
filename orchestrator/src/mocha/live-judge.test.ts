import assert from 'assert';
import { describe, it } from 'mocha';
import { DEFAULT_AGENT_MODEL_BY_PROVIDER } from '../agent-provider';
import { runLiveJudge } from '../eval/live-judge';

describe('live judge provider selection', () => {
  it('normalizes donor openai judge aliases before invoking the runner', async () => {
    const calls: Array<{ provider?: string; model?: string }> = [];

    const result = await runLiveJudge({
      attempt: 1,
      worktreePath: '/tmp/eval-worktree',
      prompt: 'Judge this candidate response.',
      provider: 'openai',
      turnRunner: async (request) => {
        calls.push({ provider: request.provider, model: request.model });
        return {
          finalText: JSON.stringify({ verdict: 'pass', summary: 'Looks good.', issues: [] }),
        };
      },
    });

    assert.strictEqual(result.attempt.verdict, 'pass');
    assert.deepStrictEqual(calls, [{ provider: 'codex', model: DEFAULT_AGENT_MODEL_BY_PROVIDER.codex }]);
  });

  it('applies claude defaults for anthropic judge aliases when no judge model is supplied', async () => {
    const calls: Array<{ provider?: string; model?: string }> = [];

    const result = await runLiveJudge({
      attempt: 1,
      worktreePath: '/tmp/eval-worktree',
      prompt: 'Judge this candidate response.',
      provider: 'anthropic',
      turnRunner: async (request) => {
        calls.push({ provider: request.provider, model: request.model });
        return {
          finalText: JSON.stringify({ verdict: 'pass', summary: 'Looks good.', issues: [] }),
        };
      },
    });

    assert.strictEqual(result.attempt.verdict, 'pass');
    assert.deepStrictEqual(calls, [{ provider: 'claude', model: DEFAULT_AGENT_MODEL_BY_PROVIDER.claude }]);
  });
});