import assert from 'assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import { loadOrchestratorConfig } from '../config';

describe('config loading', () => {
  it('defaults github status names including Escalated in the shared config layer', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-github-defaults-'));
    try {
      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.deepStrictEqual(config.github, {
        backlogStatusName: 'Backlog',
        readyStatusName: 'Ready',
        inReviewStatusName: 'In review',
        escalatedStatusName: 'Escalated',
        blockedStatusName: 'Blocked',
        branchPrefix: 'orchestrator',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults agent profiles with escalation on gpt-5.4 high reasoning', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-agent-profiles-'));
    try {
      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.deepStrictEqual(config.agentProfiles, {
        default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
        escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults pickup config to enabled donor-style schedule settings', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-pickup-defaults-'));
    try {
      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.deepStrictEqual(config.pickup, {
        enabled: true,
        intervalSeconds: 10,
        maxConcurrent: 5,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads multi-target config with a global git.branchPrefix', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-targets-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          "  git: { branchPrefix: 'feature' },",
          '  targets: [',
          '    {',
          "      id: 'acme-web',",
          "      project: { owner: 'acme', number: 42, readyStatusName: 'Queued' },",
          "      repo: { owner: 'acme', name: 'web' },",
          '    },',
          '    {',
          "      id: 'acme-api',",
          "      project: { owner: 'acme', number: 43 },",
          "      repo: { owner: 'acme', name: 'api' },",
          '    },',
          '  ],',
          '};',
        ].join('\n'),
        'utf8',
      );

      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.strictEqual(config.git.branchPrefix, 'feature');
      assert.deepStrictEqual(config.targets, [
        {
          id: 'acme-web',
          project: {
            owner: 'acme',
            number: 42,
            backlogStatusName: 'Backlog',
            readyStatusName: 'Queued',
            inReviewStatusName: 'In review',
            blockedStatusName: 'Blocked',
          },
          repo: { owner: 'acme', name: 'web' },
        },
        {
          id: 'acme-api',
          project: {
            owner: 'acme',
            number: 43,
            backlogStatusName: 'Backlog',
            readyStatusName: 'Ready',
            inReviewStatusName: 'In review',
            blockedStatusName: 'Blocked',
          },
          repo: { owner: 'acme', name: 'api' },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers an explicit config path over env override and discovered files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-precedence-'));
    const originalConfigEnv = process.env.ORCHESTRATOR_CONFIG;
    try {
      const explicitPath = path.join(tempDir, 'explicit.config.ts');
      const envPath = path.join(tempDir, 'env.config.ts');
      await writeFile(path.join(tempDir, 'orchestrator.config.ts'), "export default { targets: [{ id: 'discovered', project: { owner: 'discovered', number: 1 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      await writeFile(envPath, "export default { targets: [{ id: 'env', project: { owner: 'env', number: 2 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      await writeFile(explicitPath, "export default { targets: [{ id: 'explicit', project: { owner: 'explicit', number: 3 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      process.env.ORCHESTRATOR_CONFIG = envPath;

      const config = await loadOrchestratorConfig({ cwd: tempDir, explicitPath });

      assert.strictEqual(config.targets[0]?.project.owner, 'explicit');
      assert.strictEqual(config.targets[0]?.project.number, 3);
    } finally {
      if (originalConfigEnv === undefined) delete process.env.ORCHESTRATOR_CONFIG;
      else process.env.ORCHESTRATOR_CONFIG = originalConfigEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to NIGHT_SHIFT_CONFIG when ORCHESTRATOR_CONFIG is unset', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-night-shift-config-'));
    const originalOrchestratorConfig = process.env.ORCHESTRATOR_CONFIG;
    const originalNightShiftConfig = process.env.NIGHT_SHIFT_CONFIG;
    try {
      const envPath = path.join(tempDir, 'night-shift-env.config.ts');
      await writeFile(path.join(tempDir, 'orchestrator.config.ts'), "export default { targets: [{ id: 'discovered', project: { owner: 'discovered', number: 1 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      await writeFile(envPath, "export default { targets: [{ id: 'night-shift-env', project: { owner: 'night-shift-env', number: 9 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      delete process.env.ORCHESTRATOR_CONFIG;
      process.env.NIGHT_SHIFT_CONFIG = envPath;

      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.strictEqual(config.targets[0]?.project.owner, 'night-shift-env');
      assert.strictEqual(config.targets[0]?.project.number, 9);
    } finally {
      if (originalOrchestratorConfig === undefined) delete process.env.ORCHESTRATOR_CONFIG;
      else process.env.ORCHESTRATOR_CONFIG = originalOrchestratorConfig;
      if (originalNightShiftConfig === undefined) delete process.env.NIGHT_SHIFT_CONFIG;
      else process.env.NIGHT_SHIFT_CONFIG = originalNightShiftConfig;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers a donor-compatible config file and loads its adjacent .env first', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-test-'));
    const originalOwner = process.env.GITHUB_PROJECT_OWNER;
    const originalNumber = process.env.GITHUB_PROJECT_NUMBER;
    try {
      delete process.env.GITHUB_PROJECT_OWNER;
      delete process.env.GITHUB_PROJECT_NUMBER;
      await writeFile(path.join(tempDir, '.env'), 'GITHUB_PROJECT_OWNER=from-dotenv\nGITHUB_PROJECT_NUMBER=17\n', 'utf8');
      await writeFile(
        path.join(tempDir, 'night-shift.config.ts'),
        [
          'export default {',
          '  targets: [{',
          "    id: 'dotenv-target',",
          '    project: {',
          '      owner: process.env.GITHUB_PROJECT_OWNER,',
          "      number: Number(process.env.GITHUB_PROJECT_NUMBER ?? '0'),",
          '    },',
          "    repo: { owner: 'acme', name: 'repo' },",
          '  }],',
          '};',
        ].join('\n'),
        'utf8',
      );

      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.strictEqual(config.targets[0]?.project.owner, 'from-dotenv');
      assert.strictEqual(config.targets[0]?.project.number, 17);
    } finally {
      if (originalOwner === undefined) delete process.env.GITHUB_PROJECT_OWNER;
      else process.env.GITHUB_PROJECT_OWNER = originalOwner;
      if (originalNumber === undefined) delete process.env.GITHUB_PROJECT_NUMBER;
      else process.env.GITHUB_PROJECT_NUMBER = originalNumber;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers a repo-root config file when the cwd is the orchestrator workspace package', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-workspace-root-'));
    try {
      const workspaceRoot = path.join(tempDir, 'repo-root');
      const packageDir = path.join(workspaceRoot, 'orchestrator');
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(workspaceRoot, 'orchestrator.config.ts'), "export default { targets: [{ id: 'workspace-root', project: { owner: 'workspace-root', number: 33 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');
      await writeFile(path.join(packageDir, 'placeholder.txt'), 'placeholder\n', 'utf8');

      const config = await loadOrchestratorConfig({ cwd: packageDir });

      assert.strictEqual(config.targets[0]?.project.owner, 'workspace-root');
      assert.strictEqual(config.targets[0]?.project.number, 33);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads .mjs config files from paths that require URL escaping', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator config#url-'));
    try {
      const explicitPath = path.join(tempDir, 'config with #hash.mjs');
      await writeFile(explicitPath, "export default { targets: [{ id: 'escaped-path', project: { owner: 'escaped-path', number: 21 }, repo: { owner: 'acme', name: 'repo' } }] };\n", 'utf8');

      const config = await loadOrchestratorConfig({ explicitPath });

      assert.strictEqual(config.targets[0]?.project.owner, 'escaped-path');
      assert.strictEqual(config.targets[0]?.project.number, 21);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails validation for invalid typed config values', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-invalid-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        "export default { intake: { maxActions: 0 } };\n",
        'utf8',
      );

      await assert.rejects(() => loadOrchestratorConfig({ cwd: tempDir }), /Too small|greater than 0|positive/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});