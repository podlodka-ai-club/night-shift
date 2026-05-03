import assert from 'assert';
import os from 'node:os';
import path from 'node:path';
import { access, appendFile, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'mocha';
import type { AgentActivityDeps, CommandResult } from '../../orchestrator/lib/activity-deps';
import {
  buildFakeAgentHumanEscalationResponse,
  buildFakeAgentImplementEscalationResponse,
  buildFakeAgentImplementResponse,
  buildFakeAgentReviewOnlyEscalationResponse,
  buildFakeAgentReviewResponse,
  buildFakeAgentSpecifyEscalationResponse,
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

  it('emits assistant-authored progress events for structured turns', async () => {
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

    assert.deepStrictEqual(response.events, [
      { type: 'provider-item', payload: { type: 'message.delta', text: 'Inspecting the approved spec bundle for run-123.' } },
      { type: 'provider-item', payload: { type: 'message.delta', text: 'Preparing deterministic fake implementation output.' } },
    ]);
  });

  it('forwards emitted events to onEvent like the real Codex adapter', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);
    const seenEvents: unknown[] = [];

    await thread.run([
      'Implement the approved spec bundle.',
      'Spec files: proposal.md, tasks.md',
      'E2E_RUN_MARKER: run-123',
    ].join('\n'), {
      outputSchema: { type: 'object' },
      onEvent: (event) => {
        seenEvents.push(event);
      },
    });

    assert.deepStrictEqual(seenEvents, [
      { type: 'provider-item', payload: { type: 'message.delta', text: 'Inspecting the approved spec bundle for run-123.' } },
      { type: 'provider-item', payload: { type: 'message.delta', text: 'Preparing deterministic fake implementation output.' } },
    ]);
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

  it('returns a deterministic resolved escalation response for implement recovery', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run('You are the Escalation Manager.\nOrigin phase: implement\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), buildFakeAgentImplementEscalationResponse('run-123'));
  });

  it('returns a deterministic review-only escalation response for review recovery', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run('You are the Escalation Manager.\nOrigin phase: review\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), buildFakeAgentReviewOnlyEscalationResponse('run-123'));
  });

  it('returns a deterministic human-needed escalation response when the run marker requests it', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run('You are the Escalation Manager.\nOrigin phase: specify\nE2E_RUN_MARKER: run-123-needs-human', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), buildFakeAgentHumanEscalationResponse('run-123-needs-human', 'specify'));
  });

  it('exports a deterministic specify escalation helper for Backlog recovery', () => {
    assert.strictEqual(buildFakeAgentSpecifyEscalationResponse('run-123').resolution.resumeStatus, 'Backlog');
  });

  it('mirrors deterministic fake sessions through the Claude adapter hooks too', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const firstSession = deps.createClaudeSession(worktreePath);

    const firstResponse = await firstSession.run('Review the PR.\n## PR Diff\n```diff\n+ok\n```\nE2E_RUN_MARKER: run-456', {
      outputSchema: { type: 'object' },
    });
    assert.ok(firstSession.id);
    const resumedSession = deps.resumeClaudeSession(worktreePath, firstSession.id);
    const secondResponse = await resumedSession.run('Review the PR.\n## PR Diff\n```diff\n+ok\n```\nE2E_RUN_MARKER: run-456', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(firstResponse.finalResponse), buildFakeAgentReviewResponse('run-456', 1));
    assert.deepStrictEqual(JSON.parse(secondResponse.finalResponse), {
      commitMessage: 'test: fake e2e change for run-456',
      pullRequestTitle: 'test: fake e2e PR for run-456',
      pullRequestBody: '## Summary\n- create the deterministic fake e2e change\n- run marker: run-456',
    });
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
    createClaudeSession: () => {
      throw new Error('createClaudeSession should be overridden');
    },
    resumeClaudeSession: () => {
      throw new Error('resumeClaudeSession should be overridden');
    },
    getCancellationSignal: () => undefined,
    getHeartbeatDetails: () => undefined,
    heartbeat: () => undefined,
    signalProgress: async () => undefined,
  };
}