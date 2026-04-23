import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const ORIGINAL_ENV = { ...process.env };
const CONFIG_ENV_PREFIXES = ['AGENT_'];
const CONFIG_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_PROJECT_OWNER',
  'GITHUB_PROJECT_OWNER_TYPE',
  'GITHUB_PROJECT_NUMBER',
  'GITHUB_REPO_OWNER',
  'GITHUB_REPO_NAME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'CODEX_ENABLED',
  'CODEX_MODEL',
  'REPO_DIR',
];

const BASE_ENV = {
  GITHUB_TOKEN: 'gh-token',
  GITHUB_PROJECT_OWNER: 'owner',
  GITHUB_PROJECT_OWNER_TYPE: 'user',
  GITHUB_PROJECT_NUMBER: '1',
  GITHUB_REPO_OWNER: 'owner',
  GITHUB_REPO_NAME: 'repo',
  ANTHROPIC_API_KEY: 'anthropic-key',
  OPENAI_API_KEY: 'openai-key',
  REPO_DIR: '/tmp/repo',
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  const sanitizedEnv = { ...ORIGINAL_ENV };

  for (const key of Object.keys(sanitizedEnv)) {
    if (CONFIG_ENV_KEYS.includes(key) || CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete sanitizedEnv[key];
    }
  }

  process.env = { ...sanitizedEnv, ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

describe('loadConfig agent role selection', () => {
  beforeEach(() => {
    setEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('derives role defaults from legacy model settings when explicit role overrides are absent', () => {
    setEnv({
      CODEX_MODEL: 'gpt-5.4-mini',
      ANTHROPIC_MODEL: 'claude-3-7-sonnet-latest',
    });

    const config = loadConfig();

    expect(config.agents).toEqual({
      planner: { provider: 'codex', model: 'gpt-5.4-mini' },
      implementer: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
      reviewer: { provider: 'codex', model: 'gpt-5.4-mini' },
    });
  });

  it('uses the selected provider to resolve the fallback model for a role', () => {
    setEnv({
      ANTHROPIC_MODEL: 'claude-opus-4-1',
      AGENT_PLANNER_PROVIDER: 'anthropic',
    });

    const config = loadConfig();

    expect(config.agents.planner).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    });
  });

  it('allows explicit per-role provider and model overrides', () => {
    setEnv({
      AGENT_IMPLEMENTER_PROVIDER: 'codex',
      AGENT_IMPLEMENTER_MODEL: 'gpt-5.4',
      AGENT_REVIEWER_PROVIDER: 'anthropic',
      AGENT_REVIEWER_MODEL: 'claude-sonnet-4-7',
    });

    const config = loadConfig();

    expect(config.agents.implementer).toEqual({ provider: 'codex', model: 'gpt-5.4' });
    expect(config.agents.reviewer).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-7' });
  });

  it('rejects unsupported providers in role configuration', () => {
    setEnv({ AGENT_REVIEWER_PROVIDER: 'unsupported' });

    expect(() => loadConfig()).toThrow();
  });

  it('ships explicit pricing for gpt-5.1-codex-mini', () => {
    const config = loadConfig();

    expect(config.pricing.modelOverrides['codex:gpt-5.1-codex-mini']).toEqual({
      inputPer1kTokens: 0.00075,
      outputPer1kTokens: 0.0045,
    });
  });
});