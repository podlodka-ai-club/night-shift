import assert from 'assert';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { describe, it } from 'mocha';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../../orchestrator/lib/agent-prompts';
import type { AgentActivityDeps, CommandResult } from '../../orchestrator/lib/activity-deps';
import { FAKE_AGENT_FILE_PATH, createFakeAgentDeps } from './fake-agent';

describe('createFakeAgentDeps', () => {
  it('writes a deterministic repo change and returns deterministic metadata with the run marker', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const editTurn = await thread.run(
      buildTaskImplementationPrompt(['Test fake-agent behavior.', '', 'E2E_RUN_MARKER: run-123'].join('\n')),
    );

    const writtenFile = await readFile(path.join(worktreePath, FAKE_AGENT_FILE_PATH), 'utf8');
    assert.match(editTurn.finalResponse, /fake agent applied deterministic repository change/i);
    assert.match(writtenFile, /run-123/);

    const metadataTurn = await thread.run(buildChangeMetadataPrompt(), {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(metadataTurn.finalResponse), {
      commitMessage: 'test: fake e2e change for run-123',
      pullRequestTitle: 'test: fake e2e PR for run-123',
      pullRequestBody: '## Summary\n- create the deterministic fake e2e change\n- run marker: run-123',
    });
  });

  it('returns a deterministic OpenSpec bundle for the first structured Specify turn', async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-fake-agent-'));
    const deps = createFakeAgentDeps(buildBaseDeps());
    const thread = deps.createCodexThread(worktreePath);

    const response = await thread.run('Draft an OpenSpec proposal.\nE2E_RUN_MARKER: run-123', {
      outputSchema: { type: 'object' },
    });

    assert.deepStrictEqual(JSON.parse(response.finalResponse), {
      files: [
        { path: 'proposal.md', content: '# Proposal\n\n## Why\n- Support deterministic phases in the live fake-agent harness.' },
        { path: 'tasks.md', content: '# Tasks\n\n- [ ] Review and approve the proposed spec.' },
        { path: 'specs/e2e/spec.md', content: '## ADDED Requirements\n### Requirement: Fake agent e2e validation\nThe fake-agent e2e path MUST prove the specify gate can be approved and resumed.' },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
  });
});

function buildBaseDeps(): AgentActivityDeps {
  return {
    access,
    mkdir,
    readdir,
    readFile,
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