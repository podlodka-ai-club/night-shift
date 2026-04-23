/**
 * Integration dry-run tests.
 *
 * All external I/O (GitHub, Anthropic, Codex, git) is replaced by lightweight
 * stubs. Real RunStore writes to a temp directory on disk to exercise crash
 * recovery paths with real file I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Module stubs ─────────────────────────────────────────────────────────────
vi.mock('@octokit/graphql', () => ({ graphql: { defaults: () => vi.fn() } }));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    issues: { createComment: vi.fn().mockResolvedValue({}) },
    pulls: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { number: 7, html_url: 'https://github.com/o/r/pull/7' } }),
      update: vi.fn().mockResolvedValue({}),
    },
  })),
}));
vi.mock('simple-git', () => ({
  default: () => ({
    fetch: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue(''),
    add: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ files: [{ path: 'src/foo.ts' }] }),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue('diff --git a/src/foo.ts\n+const x = 1;'),
    deleteLocalBranch: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Stub Anthropic SDK – always returns "IMPLEMENTATION COMPLETE".
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: 'IMPLEMENTATION COMPLETE' }],
      }),
    },
  })),
}));

import { RunStore } from '../../src/store/RunStore';
import { ValidationRunner } from '../../src/workspace/ValidationRunner';
import type { Config } from '../../src/config';

function makeConfig(dataDir: string, repoDir: string): Config {
  return {
    github: {
      token: 'tok', projectOwner: 'owner', projectOwnerType: 'user',
      projectNumber: 1, repoOwner: 'owner', repoName: 'repo',
      defaultBranch: 'main', statusFieldName: 'Status',
      statusValues: { ready: 'Ready', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked' },
    },
    anthropic: { apiKey: 'key', model: 'claude-sonnet-4-6' },
    codex: { enabled: false, model: 'gpt-5-mini' },
    budgets: { specify: 0.5, implement: 2, review: 0.5, totalPerTicket: 5 },
    pricing: {
      codex: { inputPer1kTokens: 0.00075, outputPer1kTokens: 0.0045 },
      sonnet: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    },
    dataDir,
    repoDir,
  } as Config;
}

describe('Scenario: blocked on missing validation config', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-int-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-repo-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    fs.rmSync(repoDir, { recursive: true });
  });

  it('throws ValidationConfigMissingError when config is absent', async () => {
    const runner = new ValidationRunner();
    const { ValidationConfigMissingError } = await import('../../src/types');
    await expect(runner.run(repoDir)).rejects.toThrow(ValidationConfigMissingError);
  });
});

describe('Scenario: crash recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-crash-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('resumes from persisted mid-flight stage', async () => {
    const store = new RunStore(tmpDir);
    const state = {
      ticketId: 'CRASH_TICKET',
      repoOwner: 'o', repoName: 'r',
      branch: 'feature/crash',
      stage: 'implemented' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.create(state);

    // Simulate restart: create a new store instance pointing to the same dir.
    const storeAfterRestart = new RunStore(tmpDir);
    const active = await storeAfterRestart.listActive();

    expect(active).toHaveLength(1);
    expect(active[0].ticketId).toBe('CRASH_TICKET');
    expect(active[0].stage).toBe('implemented');
  });

  it('does not resume a completed run', async () => {
    const store = new RunStore(tmpDir);
    const state = {
      ticketId: 'DONE_TICKET',
      repoOwner: 'o', repoName: 'r',
      branch: 'feature/done',
      stage: 'completed' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.create(state);
    const active = await store.listActive();
    expect(active).toHaveLength(0);
  });
});

describe('Scenario: ValidationRunner happy path in integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-val-int-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('runs echo commands successfully', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'feature-factory.config.json'),
      JSON.stringify({ validation: { commands: ['echo typecheck-ok', 'echo test-ok'] } }),
    );
    const runner = new ValidationRunner();
    const results = await runner.run(tmpDir);
    expect(ValidationRunner.allPassed(results)).toBe(true);
    expect(results).toHaveLength(2);
  });
});
