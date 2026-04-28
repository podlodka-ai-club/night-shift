import assert from 'assert';
import os from 'node:os';
import path from 'node:path';
import { access, appendFile, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'mocha';
import type { AgentActivityDeps, CommandResult } from '../../orchestrator/lib/activity-deps';
import {
  buildFakeAgentImplementResponse,
    buildFakeAgentReviewResponse,
  buildFakeAgentSpecifyResponse,
  createFakeAgentDeps,
} from './fake-agent';

describe('createFakeAgentDeps', () => {
  it('returns a deterministic Implement response with the run marker', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run([
      'Implement the approved spec bundle.',
      'Spec files: proposal.md, tasks.md',
      'E2E_RUN_MARKER: run-123',
    ].join('\n'), {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), buildFakeAgentImplementResponse('run-123'));
  });

  it('returns a deterministic OpenSpec bundle for the first structured Specify turn', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run('Draft an OpenSpec proposal.\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), buildFakeAgentSpecifyResponse());
  });

  it('returns a deterministic Review response for the review structured turn', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const firstThread = deps.createCodexThread(worktreePath);
    const secondThread = deps.createCodexThread(worktreePath);

    const firstResponse = await firstThread.run('Review the PR.\n## PR Diff\n```diff\n+ok\n```\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });
    const secondResponse = await secondThread.run('Review the PR.\n## PR Diff\n```diff\n+ok\n```\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(firstResponse.finalResponse), buildFakeAgentReviewResponse('run-123', 1));
    assert.deepStrictEqual(JSON.parse(secondResponse.finalResponse), buildFakeAgentReviewResponse('run-123', 2));
  });
});

function buildBaseDeps(): AgentActivityDeps {
  return {
    access,
    mkdir,
    readdir,
    readFile,
    realpath,
    rm,
    appendFile: (targetPath, data, encoding) => appendFile(targetPath, data, encoding),
    writeFile: (targetPath, data, encoding) => writeFile(targetPath, data, encoding),
    execFile: async (): Promise<CommandResult> => {
      throw new Error('execFile should not be used by the fake agent test');
    },
    createCodexThread: () => {
      throw new Error('createCodexThread should be overridden');
    },
    resumeCodexThread: () => {
      throw new Error('resumeCodexThread should be overridden');
    },
    getCancellationSignal: () => undefined,
    getHeartbeatDetails: () => undefined,
    heartbeat: () => undefined,
  };
}