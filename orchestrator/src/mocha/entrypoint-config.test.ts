import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import {
  loadClientEntrypointConfig,
  loadWorkerEntrypointConfig,
  parseEntrypointConfigArgs,
} from '../entrypoint-config';

describe('entrypoint config wiring', () => {
  it('extracts --config from shared entrypoint args and preserves the remaining workflow args', () => {

    assert.deepStrictEqual(
      parseEntrypointConfigArgs(['--config', '/tmp/custom.config.ts', 'Ready']),
      { explicitPath: '/tmp/custom.config.ts', args: ['Ready'] },
    );
    assert.deepStrictEqual(
      parseEntrypointConfigArgs(['--config=/tmp/custom.config.ts', 'pickup', '3']),
      { explicitPath: '/tmp/custom.config.ts', args: ['pickup', '3'] },
    );
  });

  it('accepts Escalated as a manual client intake status', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-manual-escalated-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        ['export default {', "  github: { projectOwner: 'acme', projectNumber: 42 },", '};'].join('\n'),
        'utf8',
      );

      const resolved = await loadClientEntrypointConfig({ args: ['acme', '42', 'Escalated'], cwd: tempDir, env: {} });

      assert.deepStrictEqual(resolved.command, { kind: 'manual', statusName: 'Escalated' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves client workflow input and pickup command from config-file defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-config-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  agentProfiles: {',
          "    escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },",
          '  },',
          '  intake: { maxActions: 3 },',
          '  github: {',
          "    projectOwner: 'acme',",
          '    projectNumber: 42,',
          "    backlogStatusName: 'Needs Spec',",
          "    readyStatusName: 'Queued',",
          "    inReviewStatusName: 'Reviewing',",
          "    escalatedStatusName: 'Auto Recovery',",
          "    blockedStatusName: 'Paused',",
          "    branchPrefix: 'feature',",
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const resolved = await loadClientEntrypointConfig({ args: [], cwd: tempDir, env: {} });

      assert.deepStrictEqual(resolved.workflowInput, {
        projectOwner: 'acme',
        projectNumber: 42,
        backlogStatusName: 'Needs Spec',
        readyStatusName: 'Queued',
        inReviewStatusName: 'Reviewing',
        escalatedStatusName: 'Auto Recovery',
        blockedStatusName: 'Paused',
        branchPrefix: 'feature',
      });
      assert.deepStrictEqual(resolved.temporal, {
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'orchestrator',
      });
      assert.deepStrictEqual(resolved.command, { kind: 'pickup', maxActions: 3 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves worker temporal settings from the shared config layer', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-worker-config-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  temporal: {',
          "    address: 'temporal.example:7233',",
          "    namespace: 'agents',",
          "    taskQueue: 'custom-queue',",
          '  },',
          '  github: {',
          "    projectOwner: 'acme',",
          '    projectNumber: 42,',
          '  },',
          '  pickup: {',
          '    enabled: false,',
          '    intervalSeconds: 30,',
          '    maxConcurrent: 2,',
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });

      assert.deepStrictEqual(resolved, {
        temporal: {
          address: 'temporal.example:7233',
          namespace: 'agents',
          taskQueue: 'custom-queue',
        },
        workflowInput: {
          projectOwner: 'acme',
          projectNumber: 42,
          backlogStatusName: 'Backlog',
          readyStatusName: 'Ready',
          inReviewStatusName: 'In review',
          escalatedStatusName: 'Escalated',
          blockedStatusName: 'Blocked',
          branchPrefix: 'orchestrator',
        },
        pickup: {
          enabled: false,
          intervalSeconds: 30,
          maxConcurrent: 2,
        },
        agentProfiles: {
          default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
          escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults worker pickup config to enabled when the pickup block is omitted', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-worker-pickup-defaults-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  github: {',
          "    projectOwner: 'acme',",
          '    projectNumber: 42,',
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });

      assert.deepStrictEqual(resolved.pickup, {
        enabled: true,
        intervalSeconds: 10,
        maxConcurrent: 5,
      });
      assert.deepStrictEqual(resolved.agentProfiles, {
        default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
        escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads worker project coordinates from a cwd .env when no config file exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-worker-dotenv-'));
    const originalOwner = process.env.GITHUB_PROJECT_OWNER;
    const originalNumber = process.env.GITHUB_PROJECT_NUMBER;
    const originalConfig = process.env.ORCHESTRATOR_CONFIG;
    const originalNightShiftConfig = process.env.NIGHT_SHIFT_CONFIG;
    try {
      delete process.env.GITHUB_PROJECT_OWNER;
      delete process.env.GITHUB_PROJECT_NUMBER;
      delete process.env.ORCHESTRATOR_CONFIG;
      delete process.env.NIGHT_SHIFT_CONFIG;
      await writeFile(path.join(tempDir, '.env'), 'GITHUB_PROJECT_OWNER=dotenv-owner\nGITHUB_PROJECT_NUMBER=17\n', 'utf8');

      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir });

      assert.deepStrictEqual(resolved.workflowInput, {
        projectOwner: 'dotenv-owner',
        projectNumber: 17,
        backlogStatusName: 'Backlog',
        readyStatusName: 'Ready',
        inReviewStatusName: 'In review',
        escalatedStatusName: 'Escalated',
        blockedStatusName: 'Blocked',
        branchPrefix: 'orchestrator',
      });
      assert.deepStrictEqual(resolved.agentProfiles, {
        default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
        escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
      });
    } finally {
      if (originalOwner === undefined) delete process.env.GITHUB_PROJECT_OWNER;
      else process.env.GITHUB_PROJECT_OWNER = originalOwner;
      if (originalNumber === undefined) delete process.env.GITHUB_PROJECT_NUMBER;
      else process.env.GITHUB_PROJECT_NUMBER = originalNumber;
      if (originalConfig === undefined) delete process.env.ORCHESTRATOR_CONFIG;
      else process.env.ORCHESTRATOR_CONFIG = originalConfig;
      if (originalNightShiftConfig === undefined) delete process.env.NIGHT_SHIFT_CONFIG;
      else process.env.NIGHT_SHIFT_CONFIG = originalNightShiftConfig;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves the same temporal precedence for client and worker entrypoints', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-temporal-precedence-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  temporal: {',
          "    address: 'config-temporal.example:7233',",
          "    namespace: 'config-agents',",
          "    taskQueue: 'config-queue',",
          '  },',
          '  github: {',
          "    projectOwner: 'acme',",
          '    projectNumber: 42,',
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const env = {
        TEMPORAL_ADDRESS: 'env-temporal.example:7233',
        TEMPORAL_NAMESPACE: 'env-agents',
      };
      const clientResolved = await loadClientEntrypointConfig({ args: [], cwd: tempDir, env });
      const workerResolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env });

      assert.deepStrictEqual(clientResolved.temporal, workerResolved.temporal);
      assert.deepStrictEqual(workerResolved.temporal, {
        address: 'env-temporal.example:7233',
        namespace: 'env-agents',
        taskQueue: 'config-queue',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves legacy precedence with cli over env over config defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-precedence-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  intake: { maxActions: 2 },',
          '  github: {',
          "    projectOwner: 'config-owner',",
          '    projectNumber: 10,',
          "    backlogStatusName: 'Config Backlog',",
          "    readyStatusName: 'Config Ready',",
          "    inReviewStatusName: 'Config Review',",
          "    escalatedStatusName: 'Config Escalated',",
          "    blockedStatusName: 'Config Blocked',",
          "    branchPrefix: 'config-branch',",
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const resolved = await loadClientEntrypointConfig({
        args: ['cli-owner', '99', 'pickup', '4'],
        cwd: tempDir,
        env: {
          GITHUB_PROJECT_OWNER: 'env-owner',
          GITHUB_PROJECT_NUMBER: '77',
          GITHUB_BACKLOG_STATUS: 'Env Backlog',
          GITHUB_ESCALATED_STATUS: 'Env Escalated',
          GITHUB_PICKUP_MAX_ACTIONS: '3',
        },
      });

      assert.deepStrictEqual(resolved.workflowInput, {
        projectOwner: 'cli-owner',
        projectNumber: 99,
        backlogStatusName: 'Env Backlog',
        readyStatusName: 'Config Ready',
        inReviewStatusName: 'Config Review',
        escalatedStatusName: 'Env Escalated',
        blockedStatusName: 'Config Blocked',
        branchPrefix: 'config-branch',
      });
      assert.deepStrictEqual(resolved.command, { kind: 'pickup', maxActions: 4 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});