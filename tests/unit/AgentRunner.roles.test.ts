import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  codexRunMock,
  codexStartThreadMock,
  claudeQueryMock,
} = vi.hoisted(() => {
  const codexRunMock = vi.fn();
  const codexStartThreadMock = vi.fn();
  const claudeQueryMock = vi.fn();
  return { codexRunMock, codexStartThreadMock, claudeQueryMock };
});

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: codexStartThreadMock,
  })),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
}));

import { AgentRunner } from '../../src/providers/AgentRunner';
import { RunStore } from '../../src/store/RunStore';
import type { Config } from '../../src/config';

function makeConfig(overrides: Partial<Config> = {}): Config {
  const config = {
    github: {
      token: 'tok', projectOwner: 'owner', projectOwnerType: 'user',
      projectNumber: 1, repoOwner: 'owner', repoName: 'repo',
      defaultBranch: 'main', statusFieldName: 'Status',
      statusValues: { ready: 'Ready', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked' },
    },
    anthropic: { apiKey: 'anthropic-key', model: 'claude-sonnet-4-6' },
    codex: { enabled: true, apiKey: 'codex-key', model: 'gpt-5-mini' },
    agents: {
      planner: { provider: 'codex', model: 'gpt-5-mini' },
      implementer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      reviewer: { provider: 'codex', model: 'gpt-5-mini' },
    },
    budgets: { specify: 0.5, implement: 2, review: 0.5, totalPerTicket: 5 },
    pricing: {
      codex: { inputPer1kTokens: 0.00075, outputPer1kTokens: 0.0045 },
      anthropic: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      sonnet: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      modelOverrides: {},
    },
    dataDir: '/tmp',
    repoDir: '/tmp/repo',
  } as Config;

  return { ...config, ...overrides };
}

function makeStore() {
  return {
    appendUsage: vi.fn().mockResolvedValue(undefined),
    loadUsage: vi.fn().mockResolvedValue([]),
  } as unknown as RunStore;
}

async function* stream(messages: Array<Record<string, unknown>>) {
  for (const message of messages) {
    yield message;
  }
}

describe('AgentRunner role routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexRunMock.mockResolvedValue({
      finalResponse: '{"content":"ok"}',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    codexStartThreadMock.mockReturnValue({ run: codexRunMock });
    claudeQueryMock.mockReturnValue(stream([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { content: 'ok' },
        result: 'ok',
        total_cost_usd: 0.012,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]));
  });

  it('routes planner calls through the configured codex provider and records role metadata', async () => {
    const store = makeStore();
    const runner = new AgentRunner(makeConfig(), store, 'ticket-1');
    const schema = { type: 'object', properties: { content: { type: 'string' } } };

    await runner.runRole('planner', 'prompt', 'specify-proposal', 'specify', {
      structuredOutputSchema: schema,
    });

    expect(codexStartThreadMock).toHaveBeenCalledWith({
      approvalPolicy: 'never',
      model: 'gpt-5-mini',
      sandboxMode: 'read-only',
    });
    expect(codexRunMock).toHaveBeenCalledWith('prompt', { outputSchema: schema });
    expect((store.appendUsage as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ticket-1',
      expect.objectContaining({ role: 'planner', provider: 'codex', model: 'gpt-5-mini' }),
    );
  });

  it('routes reviewer calls through anthropic when configured and maps structured output', async () => {
    const store = makeStore();
    const config = makeConfig({
      agents: {
        planner: { provider: 'codex', model: 'gpt-5-mini' },
        implementer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        reviewer: { provider: 'anthropic', model: 'claude-opus-4-1' },
      },
    });
    const runner = new AgentRunner(config, store, 'ticket-1');
    const schema = { type: 'object', properties: { findings: { type: 'array' } } };

    await runner.runRole('reviewer', 'prompt', 'review-findings', 'review', {
      structuredOutputSchema: schema,
    });

    expect(claudeQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'prompt',
      options: expect.objectContaining({
        cwd: '/tmp/repo',
        model: 'claude-opus-4-1',
        outputFormat: { type: 'json_schema', schema },
      }),
    }));
    expect((store.appendUsage as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ticket-1',
      expect.objectContaining({ role: 'reviewer', provider: 'anthropic', model: 'claude-opus-4-1' }),
    );
  });

  it('routes implementer calls through codex when configured for repository work', async () => {
    const store = makeStore();
    const config = makeConfig({
      agents: {
        planner: { provider: 'codex', model: 'gpt-5-mini' },
        implementer: { provider: 'codex', model: 'gpt-5.4' },
        reviewer: { provider: 'codex', model: 'gpt-5-mini' },
      },
    });
    const runner = new AgentRunner(config, store, 'ticket-1');

    await runner.runRole('implementer', 'prompt', 'implement', 'implement', {
      workingDirectory: '/tmp/worktree',
    });

    expect(codexStartThreadMock).toHaveBeenCalledWith({
      approvalPolicy: 'never',
      model: 'gpt-5.4',
      sandboxMode: 'workspace-write',
      workingDirectory: '/tmp/worktree',
    });
    expect((store.appendUsage as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ticket-1',
      expect.objectContaining({ role: 'implementer', provider: 'codex', model: 'gpt-5.4' }),
    );
  });

  it('rejects codex-backed roles when codex is disabled', async () => {
    const store = makeStore();
    const runner = new AgentRunner(
      makeConfig({ codex: { enabled: false, apiKey: 'codex-key', model: 'gpt-5-mini' } }),
      store,
      'ticket-1',
    );

    await expect(runner.runRole('planner', 'prompt', 'specify-proposal', 'specify')).rejects.toThrow(
      'CODEX_ENABLED=false',
    );
  });

  it('rejects codex-backed roles when the OpenAI API key is missing', async () => {
    const store = makeStore();
    const runner = new AgentRunner(
      makeConfig({ codex: { enabled: true, apiKey: undefined, model: 'gpt-5-mini' } }),
      store,
      'ticket-1',
    );

    await expect(runner.runRole('planner', 'prompt', 'specify-proposal', 'specify')).rejects.toThrow(
      'OPENAI_API_KEY is not set',
    );
  });

  it('rejects anthropic-backed roles when the Anthropic API key is missing', async () => {
    const store = makeStore();
    const runner = new AgentRunner(
      makeConfig({
        anthropic: { apiKey: '', model: 'claude-sonnet-4-6' },
        agents: {
          planner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          implementer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        },
      }),
      store,
      'ticket-1',
    );

    await expect(runner.runRole('implementer', 'prompt', 'implement', 'implement')).rejects.toThrow(
      'ANTHROPIC_API_KEY is not set',
    );
  });
});