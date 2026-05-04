import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import { loadClientEntrypointConfig, loadWorkerEntrypointConfig, parseEntrypointConfigArgs } from '../entrypoint-config';
import type { AutomateReadyIssueInput } from '../shared';

describe('entrypoint config wiring', () => {
  it('extracts --config from shared entrypoint args and preserves the remaining workflow args', () => {
    assert.deepStrictEqual(parseEntrypointConfigArgs(['--config', '/tmp/custom.config.ts', 'Ready']), { explicitPath: '/tmp/custom.config.ts', args: ['Ready'] });
    assert.deepStrictEqual(parseEntrypointConfigArgs(['--config=/tmp/custom.config.ts', 'pickup', '3']), { explicitPath: '/tmp/custom.config.ts', args: ['pickup', '3'] });
  });

  it('accepts Escalated as a manual client intake status for legacy github config', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-manual-escalated-'));
    try {
      await writeConfig(tempDir, ["github: { projectOwner: 'acme', projectNumber: 42 },"]);
      const resolved = await loadClientEntrypointConfig({ args: ['acme', '42', 'Escalated'], cwd: tempDir, env: {} });
      assert.deepStrictEqual(resolved.command, { kind: 'manual', statusName: 'Escalated' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves client workflow input and pickup command from legacy github config-file defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-config-'));
    try {
      await writeConfig(tempDir, [
        'agentProfiles: {',
        "  escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },",
        '},',
        'intake: { maxActions: 3 },',
        'github: {',
        "  projectOwner: 'acme',",
        '  projectNumber: 42,',
        "  backlogStatusName: 'Needs Spec',",
        "  readyStatusName: 'Queued',",
        "  inReviewStatusName: 'Reviewing',",
        "  escalatedStatusName: 'Auto Recovery',",
        "  blockedStatusName: 'Paused',",
        "  branchPrefix: 'feature',",
        '},',
      ]);

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

  it('resolves a single configured target for client defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-client-'));
    try {
      await writeConfig(tempDir, ["intake: { maxActions: 3 },", "git: { branchPrefix: 'feature' },", targetsBlock(target('acme-web', 'acme', 42, 'Queued'))]);
      const resolved = await loadClientEntrypointConfig({ args: [], cwd: tempDir, env: {} });
      assert.deepStrictEqual(resolved.workflowInput, buildWorkflowInput({ projectNumber: 42, targetId: 'acme-web', readyStatusName: 'Queued', branchPrefix: 'feature' }));
      assert.deepStrictEqual(resolved.command, { kind: 'pickup', maxActions: 3 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves worker config from the selected target and shared temporal settings', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-worker-'));
    try {
      await writeConfig(tempDir, [
        "temporal: { address: 'temporal.example:7233', namespace: 'agents', taskQueue: 'custom-queue' },",
        "pickup: { enabled: false, intervalSeconds: 30, maxConcurrent: 2 },",
        targetsBlock(target('acme-web', 'acme', 42)),
      ]);
      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });
      assert.deepStrictEqual(resolved, {
        temporal: { address: 'temporal.example:7233', namespace: 'agents', taskQueue: 'custom-queue' },
        workflowInput: buildWorkflowInput({ projectNumber: 42, targetId: 'acme-web' }),
        pickup: { enabled: false, intervalSeconds: 30, maxConcurrent: 2 },
        agentProfiles: {
          default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
          escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves legacy worker config defaults when no targets are configured', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-worker-legacy-'));
    try {
      await writeConfig(tempDir, ["github: { projectOwner: 'acme', projectNumber: 42 },"]);
      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });
      assert.deepStrictEqual(resolved.workflowInput, {
        projectOwner: 'acme',
        projectNumber: 42,
        backlogStatusName: 'Backlog',
        readyStatusName: 'Ready',
        inReviewStatusName: 'In review',
        escalatedStatusName: 'Escalated',
        blockedStatusName: 'Blocked',
        branchPrefix: 'orchestrator',
      });
      assert.deepStrictEqual(resolved.pickup, { enabled: true, intervalSeconds: 10, maxConcurrent: 5 });
      assert.deepStrictEqual(resolved.agentProfiles, {
        default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
        escalation: { model: 'gpt-5.4', reasoningEffort: 'high' },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('requires an explicit target selector when multiple targets are configured', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-multi-'));
    try {
      await writeConfig(tempDir, [targetsBlock(target('acme-web', 'acme', 42), target('acme-api', 'acme', 43))]);
      await assert.rejects(() => loadWorkerEntrypointConfig({ cwd: tempDir, env: {} }), /Multiple configured targets exist/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches cli coordinates back to a configured target and keeps env status overrides', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-cli-'));
    try {
      await writeConfig(tempDir, ["intake: { maxActions: 2 },", "git: { branchPrefix: 'config-branch' },", targetsBlock(target('config-owner', 'config-owner', 10, 'Config Ready'), target('cli-owner', 'cli-owner', 99, 'Config Ready'))]);
      const resolved = await loadClientEntrypointConfig({
        args: ['cli-owner', '99', 'pickup', '4'],
        cwd: tempDir,
        env: {
          GITHUB_PROJECT_OWNER: 'config-owner',
          GITHUB_PROJECT_NUMBER: '10',
          GITHUB_BACKLOG_STATUS: 'Env Backlog',
          GITHUB_ESCALATED_STATUS: 'Env Escalated',
          GITHUB_PICKUP_MAX_ACTIONS: '3',
        },
      });
      assert.deepStrictEqual(resolved.workflowInput, buildWorkflowInput({
        projectOwner: 'cli-owner',
        projectNumber: 99,
        targetId: 'cli-owner',
        expectedRepoOwner: 'cli-owner',
        backlogStatusName: 'Env Backlog',
        readyStatusName: 'Config Ready',
        escalatedStatusName: 'Env Escalated',
        branchPrefix: 'config-branch',
      }));
      assert.deepStrictEqual(resolved.command, { kind: 'pickup', maxActions: 4 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('errors when cwd .env selects a project but no configured target exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-dotenv-'));
    const originalOwner = process.env.GITHUB_PROJECT_OWNER;
    const originalNumber = process.env.GITHUB_PROJECT_NUMBER;
    const originalConfig = process.env.ORCHESTRATOR_CONFIG;
    const originalNightShiftConfig = process.env.NIGHT_SHIFT_CONFIG;
    try {
      delete process.env.GITHUB_PROJECT_OWNER;
      delete process.env.GITHUB_PROJECT_NUMBER;
      delete process.env.ORCHESTRATOR_CONFIG;
      delete process.env.NIGHT_SHIFT_CONFIG;
      await writeConfig(tempDir, [targetsBlock(target('acme-web', 'acme', 42))]);
      await writeFile(path.join(tempDir, '.env'), 'GITHUB_PROJECT_OWNER=dotenv-owner\nGITHUB_PROJECT_NUMBER=17\n', 'utf8');

      await assert.rejects(
        () => loadWorkerEntrypointConfig({ cwd: tempDir }),
        /No configured target matches GitHub Project dotenv-owner\/17\./,
      );
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

  it('errors when cli or env coordinates do not match a configured target', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-missing-target-'));
    try {
      await writeConfig(tempDir, [targetsBlock(target('acme-web', 'acme', 42))]);
      await assert.rejects(() => loadClientEntrypointConfig({ args: ['other-org', '77'], cwd: tempDir, env: {} }), /No configured target matches GitHub Project other-org\/77/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applies the same temporal precedence for client and worker entrypoints', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-temporal-'));
    try {
      await writeConfig(tempDir, ["temporal: { address: 'config-temporal.example:7233', namespace: 'config-agents', taskQueue: 'config-queue' },", targetsBlock(target('acme-web', 'acme', 42))]);
      const env = { TEMPORAL_ADDRESS: 'env-temporal.example:7233', TEMPORAL_NAMESPACE: 'env-agents' };
      const clientResolved = await loadClientEntrypointConfig({ args: [], cwd: tempDir, env });
      const workerResolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env });
      assert.deepStrictEqual(clientResolved.temporal, workerResolved.temporal);
      assert.deepStrictEqual(workerResolved.temporal, { address: 'env-temporal.example:7233', namespace: 'env-agents', taskQueue: 'config-queue' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves legacy precedence with cli over env over config defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-precedence-'));
    try {
      await writeConfig(tempDir, [
        'intake: { maxActions: 2 },',
        'github: {',
        "  projectOwner: 'config-owner',",
        '  projectNumber: 10,',
        "  backlogStatusName: 'Config Backlog',",
        "  readyStatusName: 'Config Ready',",
        "  inReviewStatusName: 'Config Review',",
        "  escalatedStatusName: 'Config Escalated',",
        "  blockedStatusName: 'Config Blocked',",
        "  branchPrefix: 'config-branch',",
        '},',
      ]);

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

	  it('threads configured global agents onto workflow input without resolving per-phase defaults', async () => {
	    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-entrypoint-agents-'));
	    try {
	      await writeConfig(tempDir, [
	        "agents: { default: { provider: 'openai', config: { model: 'gpt-5.4' } }, review: { provider: 'anthropic', config: { model: 'claude-sonnet-4-6' } } },",
	        targetsBlock(target('acme-web', 'acme', 42)),
	      ]);
	      const resolved = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });

	      assert.deepStrictEqual(resolved.workflowInput, buildWorkflowInput({
	        agents: {
	          default: { provider: 'codex', config: { model: 'gpt-5.4' } },
	          review: { provider: 'claude', config: { model: 'claude-sonnet-4-6' } },
	        },
	      }));
	    } finally { await rm(tempDir, { recursive: true, force: true }); }
	  });
});

function buildWorkflowInput(overrides: Partial<AutomateReadyIssueInput> = {}) {
  return { ...buildWorkflowInputBase(), ...overrides };
}
function buildWorkflowInputBase(): AutomateReadyIssueInput {
  return {
    targetId: 'acme-web',
    projectOwner: 'acme',
    projectNumber: 42,
    expectedRepoOwner: 'acme',
    expectedRepoName: 'repo',
    backlogStatusName: 'Backlog',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    escalatedStatusName: 'Escalated',
    blockedStatusName: 'Blocked',
    branchPrefix: 'orchestrator',
  };
}

async function writeConfig(tempDir: string, bodyLines: string[]) {
  await writeFile(path.join(tempDir, 'orchestrator.config.ts'), ['export default {', ...bodyLines.map((line) => `  ${line}`), '};'].join('\n'), 'utf8');
}

function targetsBlock(...targets: string[]) {
  return `targets: [${targets.join(', ')}],`;
}

function target(id: string, owner: string, number: number, readyStatusName = 'Ready') {
  return `{ id: '${id}', project: { owner: '${owner}', number: ${number}, readyStatusName: '${readyStatusName}' }, repo: { owner: '${owner}', name: 'repo' } }`;
}
