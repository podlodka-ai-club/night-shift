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

  it('resolves client workflow input and pickup command from config-file defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-config-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          '  intake: { maxActions: 3 },',
          '  github: {',
          "    projectOwner: 'acme',",
          '    projectNumber: 42,',
          "    backlogStatusName: 'Needs Spec',",
          "    readyStatusName: 'Queued',",
          "    inReviewStatusName: 'Reviewing',",
          "    blockedStatusName: 'Paused',",
          "    branchPrefix: 'feature',",
          "    filePathPrefix: 'plans',",
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
        blockedStatusName: 'Paused',
        branchPrefix: 'feature',
        filePathPrefix: 'plans',
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
          blockedStatusName: 'Blocked',
          branchPrefix: 'orchestrator',
          filePathPrefix: 'orchestrator-runs',
        },
        pickup: {
          enabled: false,
          intervalSeconds: 30,
          maxConcurrent: 2,
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
    } finally {
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
          "    blockedStatusName: 'Config Blocked',",
          "    branchPrefix: 'config-branch',",
          "    filePathPrefix: 'config-path',",
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
          GITHUB_PICKUP_MAX_ACTIONS: '3',
        },
      });

      assert.deepStrictEqual(resolved.workflowInput, {
        projectOwner: 'cli-owner',
        projectNumber: 99,
        backlogStatusName: 'Env Backlog',
        readyStatusName: 'Config Ready',
        inReviewStatusName: 'Config Review',
        blockedStatusName: 'Config Blocked',
        branchPrefix: 'config-branch',
        filePathPrefix: 'config-path',
      });
      assert.deepStrictEqual(resolved.command, { kind: 'pickup', maxActions: 4 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});