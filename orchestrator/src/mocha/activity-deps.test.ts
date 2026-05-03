import assert from 'assert';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { WorkflowNotFoundError } from '@temporalio/common';
import { describe, it } from 'mocha';
import { createActivityDependencies } from '../activities';
import {
  createClaudeAgentAdapter,
  createCodexAgentAdapter,
  createLazyClaudeSession,
  createLazyCodexSession,
  createProviderAgentAdapter,
  resolveAgentProfiles,
} from '../activity-deps';

describe('activity dependencies', () => {
  it('closes stdin for child commands in the default command runner', async () => {
    const orchestratorRoot = path.resolve(__dirname, '..', '..');
    const result = await createActivityDependencies().execFile(
      'node',
      [
        '-e',
        [
          "process.stdin.once('end', () => {",
          "  console.log('stdin-closed');",
          '  process.exit(0);',
          '});',
          "process.stdin.resume();",
          'setTimeout(() => {',
          "  console.error('stdin-still-open');",
          '  process.exit(7);',
          '}, 100);',
        ].join(' '),
      ],
      { cwd: orchestratorRoot },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /stdin-closed/);
  });

  it('creates and resumes sessions through the Codex adapter boundary', async () => {
    const createCalls: string[] = [];
    const createProfiles: Array<string | undefined> = [];
    const resumeCalls: Array<{ worktreePath: string; threadId: string; agentProfile?: string }> = [];
    const createdSession = { id: 'created-thread', run: async () => ({ finalResponse: 'created' }) };
    const resumedSession = { id: 'resumed-thread', run: async () => ({ finalResponse: 'resumed' }) };
    const adapter = createCodexAgentAdapter({
      createCodexThread(worktreePath: string, agentProfile) {
        createCalls.push(worktreePath);
        createProfiles.push(agentProfile);
        return createdSession;
      },
      resumeCodexThread(worktreePath: string, threadId: string, agentProfile) {
        resumeCalls.push({ worktreePath, threadId, agentProfile });
        return resumedSession;
      },
    });

    assert.strictEqual(adapter.createSession('/tmp/worktree'), createdSession);
    assert.strictEqual(adapter.resumeSession('/tmp/worktree', 'thread-123', 'escalation'), resumedSession);
    assert.deepStrictEqual(createCalls, ['/tmp/worktree']);
    assert.deepStrictEqual(createProfiles, ['gpt-5.3-codex']);
    assert.deepStrictEqual(resumeCalls, [{ worktreePath: '/tmp/worktree', threadId: 'thread-123', agentProfile: 'escalation' }]);
  });

  it('merges default and override agent profiles deterministically', () => {
    assert.deepStrictEqual(resolveAgentProfiles({ escalation: { model: 'custom-escalation', reasoningEffort: 'medium' } }), {
      default: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
      escalation: { model: 'custom-escalation', reasoningEffort: 'medium' },
    });
  });

  it('creates and resumes sessions through the Claude adapter boundary', async () => {
    const createCalls: Array<{ worktreePath: string; model?: string }> = [];
    const resumeCalls: Array<{ worktreePath: string; threadId: string; model?: string }> = [];
    const createdSession = { id: 'claude-created', run: async () => ({ finalResponse: 'created' }) };
    const resumedSession = { id: 'claude-resumed', run: async () => ({ finalResponse: 'resumed' }) };
    const adapter = createClaudeAgentAdapter({
      createClaudeSession(worktreePath: string, model?: string) {
        createCalls.push({ worktreePath, model });
        return createdSession;
      },
      resumeClaudeSession(worktreePath: string, threadId: string, model?: string) {
        resumeCalls.push({ worktreePath, threadId, model });
        return resumedSession;
      },
    }, 'claude-sonnet-4-6');

    assert.strictEqual(adapter.createSession('/tmp/worktree'), createdSession);
    assert.strictEqual(adapter.resumeSession('/tmp/worktree', 'thread-123'), resumedSession);
    assert.deepStrictEqual(createCalls, [{ worktreePath: '/tmp/worktree', model: 'claude-sonnet-4-6' }]);
    assert.deepStrictEqual(resumeCalls, [{ worktreePath: '/tmp/worktree', threadId: 'thread-123', model: 'claude-sonnet-4-6' }]);
  });

  it('creates the requested provider adapter from the shared provider factory', () => {
    const calls: Array<{ provider: string; worktreePath: string; model?: string }> = [];
    const adapter = createProviderAgentAdapter({ provider: 'claude', model: 'claude-sonnet-4-6' }, {
      createCodexThread() {
        throw new Error('codex should not be selected');
      },
      resumeCodexThread() {
        throw new Error('codex should not be selected');
      },
      createClaudeSession(worktreePath: string, model?: string) {
        calls.push({ provider: 'claude', worktreePath, model });
        return { id: 'claude-session', run: async () => ({ finalResponse: 'ok' }) };
      },
      resumeClaudeSession() {
        throw new Error('resume should not be used');
      },
    });

    adapter.createSession('/tmp/worktree');
    assert.deepStrictEqual(calls, [{ provider: 'claude', worktreePath: '/tmp/worktree', model: 'claude-sonnet-4-6' }]);
  });

  it('keeps the default codex branch covered in the shared provider factory', () => {
    const calls: Array<{ provider: string; worktreePath: string; model?: string }> = [];
    const adapter = createProviderAgentAdapter({ provider: 'codex', model: 'gpt-5.3-codex' }, {
      createCodexThread(worktreePath: string, model?: string) {
        calls.push({ provider: 'codex', worktreePath, model });
        return { id: 'codex-session', run: async () => ({ finalResponse: 'ok' }) };
      },
      resumeCodexThread() {
        throw new Error('resume should not be used');
      },
      createClaudeSession() {
        throw new Error('claude should not be selected');
      },
      resumeClaudeSession() {
        throw new Error('claude should not be selected');
      },
    });

    adapter.createSession('/tmp/worktree');
    assert.deepStrictEqual(calls, [{ provider: 'codex', worktreePath: '/tmp/worktree', model: 'gpt-5.3-codex' }]);
  });

  it('keeps lazy session identity, passes schema and signal through, and forwards progress events', async () => {
    const abortController = new AbortController();
    const runCalls: Array<{ prompt: string; options?: unknown }> = [];
    const progressEvents: unknown[] = [];
    const session = createLazyCodexSession('startThread', async () => ({
      id: 'thread-123',
      async run(prompt: string, options?: unknown) {
        runCalls.push({ prompt, options });
        return {
          finalResponse: '{"ok":true}',
          items: [{ type: 'message.delta', text: 'working' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    }));

    assert.strictEqual(session.id, null);
    const result = await session.run('Return JSON', {
      outputSchema: { type: 'object' },
      signal: abortController.signal,
      onEvent: (event) => progressEvents.push(event),
    });

    assert.strictEqual(session.id, 'thread-123');
    assert.strictEqual(result.finalResponse, '{"ok":true}');
    assert.deepStrictEqual(progressEvents, [
      { type: 'provider-item', payload: { type: 'message.delta', text: 'working' } },
      { type: 'usage', payload: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);
    assert.deepStrictEqual(runCalls, [{
      prompt: 'Return JSON',
      options: { outputSchema: { type: 'object' }, signal: abortController.signal, onEvent: runCalls[0]?.options && (runCalls[0] as { options: { onEvent?: unknown } }).options.onEvent },
    }]);
  });

  it('maps Claude SDK turns into canonical usage, cost, and structured-output text', async () => {
    const queryCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    const progressEvents: unknown[] = [];
    const session = createLazyClaudeSession({
      model: 'claude-sonnet-4-6',
      worktreePath: '/tmp/worktree',
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            uuid: 'assistant-1',
            session_id: 'claude-session-1',
            message: { content: [{ type: 'text', text: 'Working through the response.' }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            uuid: 'result-1',
            session_id: 'claude-session-1',
            result: 'fallback text',
            structured_output: { ok: true },
            errors: [],
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
              output_tokens: 50,
            },
          };
        },
      }),
      onQuery: (params) => queryCalls.push(params),
    });

    assert.strictEqual(session.id, null);
    const result = await session.run('Return structured JSON', {
      outputSchema: { type: 'object' },
      onEvent: (event) => progressEvents.push(event),
    });

    assert.strictEqual(session.id, 'claude-session-1');
    assert.strictEqual(result.finalResponse, '{"ok":true}');
    assert.deepStrictEqual(result.usage, { input_tokens: 1300, cached_input_tokens: 200, output_tokens: 50 });
    assert.strictEqual(result.costMicroUsd, 4110);
    assert.deepStrictEqual(progressEvents, [
      {
        type: 'provider-item',
        payload: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'claude-session-1',
          message: { content: [{ type: 'text', text: 'Working through the response.' }] },
        },
      },
      {
        type: 'provider-item',
        payload: {
          type: 'result',
          subtype: 'success',
          uuid: 'result-1',
          session_id: 'claude-session-1',
          result: 'fallback text',
          structured_output: { ok: true },
          errors: [],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
            output_tokens: 50,
          },
        },
      },
      { type: 'usage', payload: { input_tokens: 1300, cached_input_tokens: 200, output_tokens: 50 } },
    ]);
    assert.strictEqual(queryCalls[0]?.prompt, 'Return structured JSON');
    assert.deepStrictEqual(queryCalls[0]?.options?.outputFormat, { type: 'json_schema', schema: { type: 'object' } });
  });

  it('fails loudly when a Claude query stream ends without a result message', async () => {
    const session = createLazyClaudeSession({
      model: 'claude-sonnet-4-6',
      worktreePath: '/tmp/worktree',
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            uuid: 'assistant-1',
            session_id: 'claude-session-1',
            message: { content: [{ type: 'text', text: 'Still thinking.' }] },
          };
        },
      }),
    });

    await assert.rejects(() => session.run('Return structured JSON'), /without a result message/i);
  });

  it('fails loudly when Claude returns a non-success result subtype', async () => {
    const session = createLazyClaudeSession({
      model: 'claude-sonnet-4-6',
      worktreePath: '/tmp/worktree',
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
            uuid: 'result-1',
            session_id: 'claude-session-1',
            errors: ['hit cap'],
          };
        },
      }),
    });

    await assert.rejects(() => session.run('Return structured JSON'), /error_max_turns.*hit cap/i);
  });

  it('ignores late progress signals after the workflow has already completed', async () => {
    const originalCurrent = Context.current;
    const progressCalls: Array<{ workflowId: string; message: string }> = [];

    Context.current = (() => ({
      info: { workflowExecution: { workflowId: 'ticket-7' } },
    })) as typeof Context.current;

    try {
      const deps = createActivityDependencies({
        signalWorkflowProgress: async (workflowId, message) => {
          progressCalls.push({ workflowId, message });
          throw new WorkflowNotFoundError('Workflow not found', workflowId, undefined);
        },
      });

      await assert.doesNotReject(() => deps.signalProgress('Preparing progress update.'));
      assert.deepStrictEqual(progressCalls, [{ workflowId: 'ticket-7', message: 'Preparing progress update.' }]);
    } finally {
      Context.current = originalCurrent;
    }
  });
});