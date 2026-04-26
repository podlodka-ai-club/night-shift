import assert from 'assert';
import { describe, it } from 'mocha';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
import { CHANGE_METADATA_OUTPUT_KEY } from '../shared';
import {
  buildGeneratedChangeMetadata,
  buildStructuredAgentSteps,
  buildWorktreeContext,
  createActivityTestRig,
} from './activity-test-helpers';

describe('agent sequence checkpoint behavior', () => {
  it('resumes a structured agent sequence from heartbeat checkpoint details', async () => {
    const worktree = buildWorktreeContext();
    const runCalls: string[] = [];
    const resumeCalls: Array<{ worktreePath: string; threadId: string }> = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => {
        throw new Error('create should not be used when a checkpoint exists');
      },
        resumeCodexThread: (worktreePath: string, threadId: string) => {
        resumeCalls.push({ worktreePath, threadId });
        return { id: 'thread-123', run: async (prompt: string) => { runCalls.push(prompt); return { items: [], finalResponse: JSON.stringify(buildGeneratedChangeMetadata()), usage: null }; } };
      },
        getHeartbeatDetails: () => ({ threadId: 'thread-123', completedStepIds: ['edit'], outputs: {}, finalResponse: 'Implemented the requested change.' }),
        heartbeat: () => undefined,
      },
    });

    const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });
    assert.deepStrictEqual(resumeCalls, [{ worktreePath: worktree.worktreePath, threadId: 'thread-123' }]);
    assert.deepStrictEqual(runCalls, [buildChangeMetadataPrompt()]);
    assert.deepStrictEqual(result.completedStepIds, ['edit', 'change-metadata']);
    assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
  });

  it('finalizes pending structured and prompt checkpoints without rerunning Codex', async () => {
    const structuredHeartbeatCalls: unknown[] = [];
    const promptHeartbeatCalls: unknown[] = [];

    const { runAgentSequence: runStructuredSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => { throw new Error('create should not be used'); },
        resumeCodexThread: () => { throw new Error('resume should not be used'); },
        getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
        pendingStep: {
          stepId: 'change-metadata',
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          output: { resultKey: CHANGE_METADATA_OUTPUT_KEY, parsedOutput: buildGeneratedChangeMetadata() },
        },
      }),
        heartbeat: (details: unknown) => structuredHeartbeatCalls.push(details),
      },
    });

    const structuredResult = await runStructuredSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) });
    assert.deepStrictEqual(structuredResult.completedStepIds, ['edit', 'change-metadata']);
    assert.deepStrictEqual(structuredHeartbeatCalls, [{
      threadId: 'thread-123',
      completedStepIds: ['edit', 'change-metadata'],
      outputs: { changeMetadata: buildGeneratedChangeMetadata() },
      finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
    }]);

    const { runAgentSequence: runPromptSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => { throw new Error('create should not be used'); },
        resumeCodexThread: () => { throw new Error('resume should not be used'); },
        getHeartbeatDetails: () => ({ threadId: 'thread-123', completedStepIds: [], outputs: {}, pendingStep: { stepId: 'edit', finalResponse: 'Implemented the requested change.' } }),
        heartbeat: (details: unknown) => promptHeartbeatCalls.push(details),
      },
    });

    const promptResult = await runPromptSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }],
    });
    assert.deepStrictEqual(promptResult, { threadId: 'thread-123', completedStepIds: ['edit'], outputs: {}, finalResponse: 'Implemented the requested change.' });
    assert.deepStrictEqual(promptHeartbeatCalls, [{ threadId: 'thread-123', completedStepIds: ['edit'], outputs: {}, finalResponse: 'Implemented the requested change.' }]);
  });

  it('finalizes a legacy pendingStructuredStep checkpoint without rerunning Codex', async () => {
    const heartbeatCalls: unknown[] = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => { throw new Error('create should not be used'); },
        resumeCodexThread: () => { throw new Error('resume should not be used'); },
        getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
        pendingStructuredStep: {
          stepId: 'change-metadata',
          resultKey: CHANGE_METADATA_OUTPUT_KEY,
          parsedOutput: buildGeneratedChangeMetadata(),
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
        },
      }),
        heartbeat: (details: unknown) => heartbeatCalls.push(details),
      },
    });

    const result = await runAgentSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) });
    assert.deepStrictEqual(result.completedStepIds, ['edit', 'change-metadata']);
    assert.deepStrictEqual(heartbeatCalls, [{
      threadId: 'thread-123',
      completedStepIds: ['edit', 'change-metadata'],
      outputs: { changeMetadata: buildGeneratedChangeMetadata() },
      finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
    }]);
  });

  it('resumes from the recorded checkpoint after a later step fails', async () => {
    const worktree = buildWorktreeContext();
    const runCalls: string[] = [];
    let phase: 'initial' | 'retry' = 'initial';
    let checkpointDetails: unknown;
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
        id: 'thread-123',
        run: async (prompt: string) => {
          runCalls.push(`initial:${prompt}`);
          if (prompt === buildTaskImplementationPrompt(worktree.taskDescription)) {
            return { finalResponse: 'Implemented the requested change.' };
          }
          throw new Error('second step failed');
        },
      }),
        resumeCodexThread: (_worktreePath: string, threadId: string) => ({
        id: threadId,
        run: async (prompt: string) => {
          runCalls.push(`retry:${prompt}`);
          return { finalResponse: JSON.stringify(buildGeneratedChangeMetadata()) };
        },
      }),
        getHeartbeatDetails: () => (phase === 'retry' ? checkpointDetails : undefined),
        heartbeat: (details: unknown) => {
        checkpointDetails = details;
      },
      },
    });

    await assert.rejects(() => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }), /second step failed/);
    phase = 'retry';
    const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });
    assert.deepStrictEqual(runCalls, [
      `initial:${buildTaskImplementationPrompt(worktree.taskDescription)}`,
      `initial:${buildChangeMetadataPrompt()}`,
      `retry:${buildChangeMetadataPrompt()}`,
    ]);
    assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
  });

  it('rejects stale completed step ids from a checkpoint created for a different step sequence', async () => {
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => { throw new Error('create should not be used'); },
        resumeCodexThread: () => { throw new Error('resume should not be used'); },
        getHeartbeatDetails: () => ({ threadId: 'thread-123', completedStepIds: ['obsolete-step'], outputs: {}, finalResponse: 'Implemented the requested change.' }),
        heartbeat: () => undefined,
      },
    });

    await assert.rejects(() => runAgentSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) }), /stale completed step ids/i);
  });

  it('truncates large final responses before storing them in heartbeat checkpoints', async () => {
    const heartbeatCalls: unknown[] = [];
    const largeResponse = `${'x'.repeat(300_000)}\ncompleted`;
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({ id: 'thread-123', run: async () => ({ finalResponse: largeResponse }) }),
        resumeCodexThread: () => { throw new Error('resume should not be used'); },
        getHeartbeatDetails: () => undefined,
        heartbeat: (details: unknown) => heartbeatCalls.push(details),
      },
    });

    const result = await runAgentSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'edit', kind: 'prompt', prompt: buildTaskImplementationPrompt(buildWorktreeContext().taskDescription) }],
    });

    assert.strictEqual(result.finalResponse, largeResponse);
    const pendingHeartbeat = heartbeatCalls.find(
      (details) => typeof details === 'object' && details !== null && 'pendingStep' in details,
    ) as { pendingStep: { finalResponse: string } } | undefined;
    assert.ok(pendingHeartbeat);
    assert.match(pendingHeartbeat.pendingStep.finalResponse, /truncated for Temporal heartbeat checkpoint/);
    assert.ok(Buffer.byteLength(pendingHeartbeat.pendingStep.finalResponse, 'utf8') <= 256 * 1024);
  });
});