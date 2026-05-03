import assert from 'assert';
import { describe, it } from 'mocha';
import {
  DEFAULT_AGENT_MODEL_BY_PROVIDER,
  DEFAULT_AGENT_PROVIDER,
  resolveAgentProviderSelection,
} from '../agent-provider';

describe('agent provider selection', () => {
  it('defaults to the canonical codex provider and model', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection(), {
      provider: DEFAULT_AGENT_PROVIDER,
      model: DEFAULT_AGENT_MODEL_BY_PROVIDER.codex,
    });
  });

  it('uses the provider default model when only the provider is specified', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection({ provider: 'claude' }), {
      provider: 'claude',
      model: DEFAULT_AGENT_MODEL_BY_PROVIDER.claude,
    });
  });

  it('normalizes the donor claude-agent alias to the canonical claude provider id', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection({ provider: 'claude-agent' }), {
      provider: 'claude',
      model: DEFAULT_AGENT_MODEL_BY_PROVIDER.claude,
    });
  });

  it('normalizes donor openai/anthropic aliases to the canonical provider ids', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection({ provider: 'openai' }), {
      provider: 'codex',
      model: DEFAULT_AGENT_MODEL_BY_PROVIDER.codex,
    });
    assert.deepStrictEqual(resolveAgentProviderSelection({ provider: 'anthropic' }), {
      provider: 'claude',
      model: DEFAULT_AGENT_MODEL_BY_PROVIDER.claude,
    });
  });

  it('infers the claude provider from a claude model when provider is omitted', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection({ model: 'claude-haiku-4-5' }), {
      provider: 'claude',
      model: 'claude-haiku-4-5',
    });
  });

  it('infers the codex provider from gpt-family models when provider is omitted', () => {
    assert.deepStrictEqual(resolveAgentProviderSelection({ model: 'gpt-5.4' }), {
      provider: 'codex',
      model: 'gpt-5.4',
    });
  });

  it('rejects unsupported providers directly through the shared selection helper', () => {
    assert.throws(
      () => resolveAgentProviderSelection({ provider: 'unknown' }),
      /unsupported provider/i,
    );
  });

  it('rejects provider and model combinations from different provider families', () => {
    assert.throws(
      () => resolveAgentProviderSelection({ provider: 'codex', model: 'claude-sonnet-4-6' }),
      /does not match provider/i,
    );
  });
});