import assert from 'assert';
import { describe, it } from 'mocha';
import { type AgentCheckpoint } from '../activity-agent-checkpoint';
import { AgentContractError, runStructuredAgentTurn } from '../activity-agent-turn';
import { changeMetadataJsonSchemaSource, changeMetadataSchema } from '../change-metadata';

describe('structured agent turn helper', () => {
  const contract = {
    jsonSchema: changeMetadataJsonSchemaSource,
    parse: (value: unknown) => changeMetadataSchema.parse(value),
  };

  function buildDeps(overrides: Partial<{
    heartbeat: (details: unknown) => void;
    getCancellationSignal: () => AbortSignal | undefined;
  }> = {}) {
    return {
      heartbeat: () => undefined,
      getCancellationSignal: () => undefined,
      ...overrides,
    };
  }

  function buildCheckpoint(): AgentCheckpoint {
    return { threadId: 'thread-123', completedStepIds: ['edit'], outputs: {}, finalResponse: 'done' };
  }

  it('returns parsed output immediately when the first response is valid', async () => {
    let runCount = 0;
    const result = await runStructuredAgentTurn(
      buildDeps(),
      {
        id: 'thread-123',
        async run(_prompt: string) {
          runCount += 1;
          return {
            finalResponse: JSON.stringify({
              commitMessage: 'feat: valid metadata',
              pullRequestTitle: 'feat: valid metadata',
              pullRequestBody: '## Summary\n- fixed',
            }),
          };
        },
      },
      { stepId: 'change-metadata', prompt: 'Return metadata', contract, getCheckpointDetails: buildCheckpoint },
    );

    assert.strictEqual(runCount, 1);
    assert.strictEqual(result.parsedOutput.commitMessage, 'feat: valid metadata');
  });

  it('repairs invalid structured output and returns the parsed payload', async () => {
    const prompts: string[] = [];
    const result = await runStructuredAgentTurn(
      buildDeps(),
      {
        id: 'thread-123',
        async run(prompt) {
          prompts.push(prompt);
          return prompts.length === 1
            ? { finalResponse: '{"commitMessage":42}' }
            : {
                finalResponse: JSON.stringify({
                  commitMessage: 'feat: valid metadata',
                  pullRequestTitle: 'feat: valid metadata',
                  pullRequestBody: '## Summary\n- fixed',
                }),
              };
        },
      },
      { stepId: 'change-metadata', prompt: 'Return metadata', contract, getCheckpointDetails: buildCheckpoint },
    );

    assert.strictEqual(prompts.length, 2);
    assert.match(prompts[1] ?? '', /previous response did not satisfy/i);
    assert.strictEqual(result.parsedOutput.commitMessage, 'feat: valid metadata');
  });

  it('truncates oversized invalid output in the repair prompt', async () => {
    const prompts: string[] = [];
    const oversizedOriginalPrompt = `Return metadata\n${'p'.repeat(20_000)}`;
    const oversizedInvalidResponse = JSON.stringify({ commitMessage: 'x'.repeat(40_000) });

    const result = await runStructuredAgentTurn(
      buildDeps(),
      {
        id: 'thread-123',
        async run(prompt: string) {
          prompts.push(prompt);
          return prompts.length === 1
            ? { finalResponse: oversizedInvalidResponse }
            : {
                finalResponse: JSON.stringify({
                  commitMessage: 'feat: valid metadata',
                  pullRequestTitle: 'feat: valid metadata',
                  pullRequestBody: '## Summary\n- fixed',
                }),
              };
        },
      },
      { stepId: 'change-metadata', prompt: oversizedOriginalPrompt, contract, getCheckpointDetails: buildCheckpoint },
    );

    assert.strictEqual(result.parsedOutput.commitMessage, 'feat: valid metadata');
    assert.match(prompts[1] ?? '', /truncated original prompt for repair prompt/);
    assert.match(prompts[1] ?? '', /truncated invalid response for repair prompt/);
    assert.ok(Buffer.byteLength(prompts[1] ?? '', 'utf8') < Buffer.byteLength(oversizedOriginalPrompt, 'utf8') + Buffer.byteLength(oversizedInvalidResponse, 'utf8'));
  });

  it('classifies repair-exhausted schema failures as contract errors', async () => {
    await assert.rejects(
      () =>
        runStructuredAgentTurn(
          buildDeps(),
          {
            id: 'thread-123',
            async run() {
              return { finalResponse: '{"commitMessage":42}' };
            },
          },
          { stepId: 'change-metadata', prompt: 'Return metadata', contract, getCheckpointDetails: buildCheckpoint },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AgentContractError);
        assert.match((error as Error).message, /did not satisfy schema/i);
        return true;
      },
    );
  });

  it('does not wrap infrastructure/runtime failures as contract errors', async () => {
    await assert.rejects(
      () =>
        runStructuredAgentTurn(
          buildDeps(),
          {
            id: 'thread-123',
            async run() {
              throw new Error('transport failed');
            },
          },
          { stepId: 'change-metadata', prompt: 'Return metadata', contract, getCheckpointDetails: buildCheckpoint },
        ),
      (error: unknown) => {
        assert.ok(!(error instanceof AgentContractError));
        assert.match((error as Error).message, /transport failed/i);
        return true;
      },
    );
  });
});