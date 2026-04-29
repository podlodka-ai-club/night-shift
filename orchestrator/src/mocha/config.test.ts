import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import { loadOrchestratorConfig } from '../config';

describe('config loading', () => {
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

  it('prefers an explicit config path over env override and discovered files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-config-precedence-'));
    const originalConfigEnv = process.env.ORCHESTRATOR_CONFIG;
    try {
      const explicitPath = path.join(tempDir, 'explicit.config.ts');
      const envPath = path.join(tempDir, 'env.config.ts');
      await writeFile(path.join(tempDir, 'orchestrator.config.ts'), "export default { github: { projectOwner: 'discovered', projectNumber: 1 } };\n", 'utf8');
      await writeFile(envPath, "export default { github: { projectOwner: 'env', projectNumber: 2 } };\n", 'utf8');
      await writeFile(explicitPath, "export default { github: { projectOwner: 'explicit', projectNumber: 3 } };\n", 'utf8');
      process.env.ORCHESTRATOR_CONFIG = envPath;

      const config = await loadOrchestratorConfig({ cwd: tempDir, explicitPath });

      assert.strictEqual(config.github.projectOwner, 'explicit');
      assert.strictEqual(config.github.projectNumber, 3);
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
      await writeFile(path.join(tempDir, 'orchestrator.config.ts'), "export default { github: { projectOwner: 'discovered', projectNumber: 1 } };\n", 'utf8');
      await writeFile(envPath, "export default { github: { projectOwner: 'night-shift-env', projectNumber: 9 } };\n", 'utf8');
      delete process.env.ORCHESTRATOR_CONFIG;
      process.env.NIGHT_SHIFT_CONFIG = envPath;

      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.strictEqual(config.github.projectOwner, 'night-shift-env');
      assert.strictEqual(config.github.projectNumber, 9);
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
          '  github: {',
          '    projectOwner: process.env.GITHUB_PROJECT_OWNER,',
          "    projectNumber: Number(process.env.GITHUB_PROJECT_NUMBER ?? '0'),",
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const config = await loadOrchestratorConfig({ cwd: tempDir });

      assert.strictEqual(config.github.projectOwner, 'from-dotenv');
      assert.strictEqual(config.github.projectNumber, 17);
    } finally {
      if (originalOwner === undefined) delete process.env.GITHUB_PROJECT_OWNER;
      else process.env.GITHUB_PROJECT_OWNER = originalOwner;
      if (originalNumber === undefined) delete process.env.GITHUB_PROJECT_NUMBER;
      else process.env.GITHUB_PROJECT_NUMBER = originalNumber;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads .mjs config files from paths that require URL escaping', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator config#url-'));
    try {
      const explicitPath = path.join(tempDir, 'config with #hash.mjs');
      await writeFile(explicitPath, "export default { github: { projectOwner: 'escaped-path', projectNumber: 21 } };\n", 'utf8');

      const config = await loadOrchestratorConfig({ explicitPath });

      assert.strictEqual(config.github.projectOwner, 'escaped-path');
      assert.strictEqual(config.github.projectNumber, 21);
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