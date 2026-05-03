import assert from 'assert';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { describe, it } from 'mocha';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
import { CHANGE_METADATA_OUTPUT_KEY, SPECIFY_RESPONSE_OUTPUT_KEY, type AgentStep, type WorktreeContext } from '../shared';
import {
  buildGeneratedChangeMetadata,
  buildStructuredAgentSteps,
  buildWorktreeContext,
  createActivityTestRig,
} from './activity-test-helpers';

describe('agent sequence activities', () => {
  it('invokes codex in the worktree during runAgentLegacy', async () => {
    const worktree = buildWorktreeContext();
    const commandCalls: Array<{ cwd?: string; args: string[] }> = [];
    const { runAgentLegacy } = createActivityTestRig({
      agent: { execFile: async (file, args, options) => {
        commandCalls.push({ args: [file, ...args], cwd: options?.cwd });
        return { stdout: 'done', stderr: '', exitCode: 0 };
      } },
    });

    await runAgentLegacy({ worktree });
    assert.deepStrictEqual(commandCalls, [
      {
        cwd: worktree.worktreePath,
        args: ['codex', 'exec', '--full-auto', '--model', 'gpt-5.3-codex', '--config', 'model_reasoning_effort="low"', buildTaskImplementationPrompt(worktree.taskDescription)],
      },
    ]);
  });

  it('uses the escalation agent profile for legacy codex execution when requested', async () => {
    const worktree = buildWorktreeContext();
    const commandCalls: Array<{ cwd?: string; args: string[] }> = [];
    const { runAgentLegacy } = createActivityTestRig({
      agent: { execFile: async (file, args, options) => {
        commandCalls.push({ args: [file, ...args], cwd: options?.cwd });
        return { stdout: 'done', stderr: '', exitCode: 0 };
      }, getAgentProfile: (agentProfile) => agentProfile === 'escalation'
        ? { model: 'gpt-5.4', reasoningEffort: 'high' }
        : { model: 'gpt-5.3-codex', reasoningEffort: 'low' } },
    });

    await runAgentLegacy({ worktree, agentProfile: 'escalation' });
    assert.deepStrictEqual(commandCalls, [
      {
        cwd: worktree.worktreePath,
        args: ['codex', 'exec', '--full-auto', '--model', 'gpt-5.4', '--config', 'model_reasoning_effort="high"', buildTaskImplementationPrompt(worktree.taskDescription)],
      },
    ]);
  });

  it('passes the Temporal cancellation signal to the CLI codex path', async () => {
    const worktree = buildWorktreeContext();
    const abortController = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const { runAgentLegacy } = createActivityTestRig({
      agent: {
        execFile: async (_file, _args, options) => {
          signals.push(options?.signal);
          return { stdout: 'done', stderr: '', exitCode: 0 };
        },
        getCancellationSignal: () => abortController.signal,
      },
    });

    await runAgentLegacy({ worktree });
    assert.deepStrictEqual(signals, [abortController.signal]);
  });

  it('runs a same-thread structured agent sequence and returns parsed outputs', async () => {
    const worktree = buildWorktreeContext();
    const heartbeatCalls: unknown[] = [];
    const runCalls: Array<{ prompt: string; outputSchema?: unknown }> = [];
    const thread = {
      id: 'thread-123',
      run: async (prompt: string, options?: { outputSchema?: unknown }) => {
        runCalls.push({ prompt, outputSchema: options?.outputSchema });
        if (runCalls.length === 1) {
          return { items: [], finalResponse: 'Implemented the requested change.', usage: null };
        }
        return { items: [], finalResponse: JSON.stringify(buildGeneratedChangeMetadata()), usage: null };
      },
    };
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => thread,
        resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
        getHeartbeatDetails: () => undefined,
        heartbeat: (details: unknown) => heartbeatCalls.push(details),
      },
    });

    const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

    assert.strictEqual(runCalls.length, 2);
    assert.deepStrictEqual(runCalls[0], {
      prompt: buildTaskImplementationPrompt(worktree.taskDescription),
      outputSchema: undefined,
    });
    assert.strictEqual(runCalls[1].prompt, buildChangeMetadataPrompt());
    assert.strictEqual((runCalls[1].outputSchema as { type?: string })?.type, 'object');
    assert.deepStrictEqual(result, {
      threadId: 'thread-123',
      completedStepIds: ['edit', 'change-metadata'],
      outputs: { changeMetadata: buildGeneratedChangeMetadata() },
      finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
    });
    assert.strictEqual(heartbeatCalls.length, 6);
  });

  it('uses the escalation agent profile when creating a structured-turn session', async () => {
    const worktree = buildWorktreeContext();
    const createCalls: Array<{ worktreePath: string; agentProfile?: string }> = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: (worktreePath, agentProfile) => {
          createCalls.push({ worktreePath, agentProfile });
          return {
            id: 'thread-123',
            run: async () => ({ items: [], finalResponse: JSON.stringify(buildGeneratedChangeMetadata()), usage: null }),
          };
        },
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    await runAgentSequence({
      worktree,
      steps: [{ id: 'change-metadata', kind: 'structured', prompt: buildChangeMetadataPrompt(), schemaId: 'change-metadata-v1', resultKey: CHANGE_METADATA_OUTPUT_KEY }],
      agentProfile: 'escalation',
    });

    assert.deepStrictEqual(createCalls, [{ worktreePath: worktree.worktreePath, agentProfile: 'escalation' }]);
  });

  it('signals assistant-authored prompt progress from provider items and dedupes repeats', async () => {
    const progressSignals: string[] = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async () => ({
            items: [
              { type: 'message.delta', text: 'Inspecting repository context.' },
              { type: 'tool-use', tool: 'npm test' },
              { type: 'message.delta', text: 'Inspecting repository context.' },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Preparing code changes.' }] },
            ],
            finalResponse: 'Implemented the requested change.',
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
        signalProgress: async (message: string) => {
          progressSignals.push(message);
        },
      } as any,
    });

    await runAgentSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }],
    });

    assert.deepStrictEqual(progressSignals, [
      'Inspecting repository context.',
      'Preparing code changes.',
    ]);
  });

  it('signals assistant-authored progress for structured turns while ignoring tool-only items', async () => {
    const progressSignals: string[] = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async () => ({
            items: [
              { type: 'tool-use', tool: 'npm test' },
              { type: 'message.delta', text: 'Validating the proposed metadata.' },
            ],
            finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
            usage: { inputTokens: 15, outputTokens: 6 },
          }),
        }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
        signalProgress: async (message: string) => {
          progressSignals.push(message);
        },
      } as any,
    });

    await runAgentSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'change-metadata', kind: 'structured', prompt: buildChangeMetadataPrompt(), schemaId: 'change-metadata-v1', resultKey: CHANGE_METADATA_OUTPUT_KEY }],
    });

    assert.deepStrictEqual(progressSignals, ['Validating the proposed metadata.']);
  });

  it('repairs a structured step when the first response is invalid', async () => {
    const runCalls: string[] = [];
    const thread = {
      id: 'thread-123',
      run: async (prompt: string) => {
        runCalls.push(prompt);
        if (runCalls.length === 1) return { items: [], finalResponse: 'Implemented the requested change.', usage: null };
        if (runCalls.length === 2) return { items: [], finalResponse: '{"commitMessage":42}', usage: null };
        return { items: [], finalResponse: JSON.stringify(buildGeneratedChangeMetadata()), usage: null };
      },
    };
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => thread,
        resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    const result = await runAgentSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) });
    assert.strictEqual(runCalls.length, 3);
    assert.match(runCalls[2], /previous response did not satisfy the required structured output schema/i);
    assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
  });

  it('repairs a Specify structured step and returns the parsed spec bundle', async () => {
    const runCalls: string[] = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async (prompt: string) => {
            runCalls.push(prompt);
            if (runCalls.length === 1) return { items: [], finalResponse: '{"files":[{"path":"notes.txt","content":"nope"}],"openQuestions":[],"assumptions":[],"risks":[]}', usage: null };
            return {
              items: [],
              finalResponse: JSON.stringify({
                files: [
                  { path: 'proposal.md', content: '# Proposal' },
                  { path: 'tasks.md', content: '# Tasks' },
                ],
                openQuestions: [],
                assumptions: [],
                risks: [],
              }),
              usage: null,
            };
          },
        }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    const result = await runAgentSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'specify', kind: 'structured', prompt: 'Draft the spec bundle.', schemaId: 'specify-response-v1', resultKey: SPECIFY_RESPONSE_OUTPUT_KEY }],
    });

    assert.strictEqual(runCalls.length, 2);
    assert.match(runCalls[1], /previous response did not satisfy the required structured output schema/i);
    assert.deepStrictEqual(result.outputs[SPECIFY_RESPONSE_OUTPUT_KEY], {
      files: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '# Tasks' },
      ],
      openQuestions: [],
      assumptions: [],
      risks: [],
    });
  });

  it('fails instead of silently dropping structured output when repair also fails', async () => {
    let runCount = 0;
    const { runAgentSequence } = createActivityTestRig({
      agent: { createCodexThread: () => ({
        id: 'thread-123',
        run: async () => {
          runCount += 1;
          return runCount === 1
            ? { items: [], finalResponse: 'Implemented the requested change.', usage: null }
            : { items: [], finalResponse: '{"commitMessage":42}', usage: null };
        },
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
      },
    });

    await assert.rejects(() => runAgentSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) }), /did not satisfy schema/);
  });

  it('rethrows repair-exhausted schema failures as non-retryable AgentContractError application failures', async () => {
    let runCount = 0;
    const worktree = buildWorktreeContext();
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async () => {
            runCount += 1;
            return runCount === 1
              ? { items: [], finalResponse: 'Implemented the requested change.', usage: null }
              : { items: [], finalResponse: '{"commitMessage":42}', usage: null };
          },
        }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    await assert.rejects(
      () => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationFailure);
        assert.strictEqual(error.type, 'AgentContractError');
        assert.strictEqual(error.nonRetryable, true);
        assert.match(error.message, /did not satisfy schema/i);
        return true;
      },
    );
  });

  it('passes the Temporal cancellation signal to the structured agent path', async () => {
    const abortController = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({
          id: 'thread-123',
          run: async (_prompt: string, options?: { signal?: AbortSignal }) => {
            signals.push(options?.signal);
            return { finalResponse: 'Implemented the requested change.' };
          },
        }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        getCancellationSignal: () => abortController.signal,
      },
    });

    const result = await runAgentSequence({
      worktree: buildWorktreeContext(),
      steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }],
    });
    assert.strictEqual(result.threadId, 'thread-123');
    assert.deepStrictEqual(signals, [abortController.signal]);
  });

  it('propagates CancelledFailure raised by Temporal heartbeat delivery', async () => {
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({ id: 'thread-123', run: async () => ({ finalResponse: 'Implemented the requested change.' }) }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        heartbeat: () => {
          throw new CancelledFailure('cancelled');
        },
      },
    });

    await assert.rejects(
      () => runAgentSequence({ worktree: buildWorktreeContext(), steps: [{ id: 'edit', kind: 'prompt', prompt: buildTaskImplementationPrompt(buildWorktreeContext().taskDescription) }] }),
      CancelledFailure,
    );
  });

  it('prioritizes CancelledFailure over a concurrent thread.run failure', async () => {
    let heartbeatCount = 0;
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({ id: 'thread-123', run: async () => { throw new Error('thread run failed'); } }),
        resumeCodexThread: () => {
          throw new Error('resume should not be used without a checkpoint');
        },
        heartbeat: () => {
          heartbeatCount += 1;
          if (heartbeatCount >= 2) throw new CancelledFailure('cancelled');
        },
      },
    });

    await assert.rejects(
      () => runAgentSequence({ worktree: buildWorktreeContext(), steps: [{ id: 'edit', kind: 'prompt', prompt: buildTaskImplementationPrompt(buildWorktreeContext().taskDescription) }] }),
      CancelledFailure,
    );
  });

  it('propagates heartbeat detail access failures that are not missing-context errors', async () => {
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        getHeartbeatDetails: () => {
          throw new Error('heartbeat detail deserialization failed');
        },
      },
    });

    await assert.rejects(() => runAgentSequence({ worktree: buildWorktreeContext(), steps: buildStructuredAgentSteps(buildWorktreeContext()) }), /heartbeat detail deserialization failed/);
  });

  it('fails when the Codex thread id is still unavailable after a step completes', async () => {
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({ id: null, run: async () => ({ finalResponse: 'Implemented the requested change.' }) }),
        resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    await assert.rejects(
      () => runAgentSequence({ worktree: buildWorktreeContext(), steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }] }),
      /thread id was unavailable after completing step edit/,
    );
  });

  it('fails fast when the Codex SDK returns a thread without a callable run method', async () => {
    const { runAgentSequence } = createActivityTestRig({
      agent: {
        createCodexThread: () => ({ id: 'thread-123' } as unknown as { id: string; run: never }),
        resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
        getHeartbeatDetails: () => undefined,
        heartbeat: () => undefined,
      },
    });

    await assert.rejects(
      () => runAgentSequence({ worktree: buildWorktreeContext(), steps: [{ id: 'edit', kind: 'prompt', prompt: 'Implement the task in this repository.' }] }),
      /callable run\(\) method/,
    );
  });

  it('rejects duplicate structured agent step ids', async () => {
    const worktree = buildWorktreeContext();
    const { runAgentSequence } = createActivityTestRig();
    await assert.rejects(
      () =>
        runAgentSequence({
          worktree,
          steps: [
            { id: 'duplicate', kind: 'prompt', prompt: 'Implement the task in this repository.' },
            {
              id: 'duplicate',
              kind: 'structured',
              prompt: buildChangeMetadataPrompt(),
              schemaId: 'change-metadata-v1',
              resultKey: CHANGE_METADATA_OUTPUT_KEY,
            },
          ],
        }),
      /Duplicate id: duplicate/,
    );
  });

  it('rejects empty structured agent step sequences', async () => {
    const worktree = buildWorktreeContext();
    const { runAgentSequence } = createActivityTestRig();
    await assert.rejects(
      () => (runAgentSequence as unknown as (input: { worktree: WorktreeContext; steps: AgentStep[] }) => Promise<unknown>)({ worktree, steps: [] }),
      /must not be empty/,
    );
  });
});