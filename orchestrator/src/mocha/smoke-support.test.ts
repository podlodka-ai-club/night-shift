import assert from 'assert';
import { describe, it } from 'mocha';
import { summarizeProviderStreamActivity, summarizeToolActivity, validateOutputSchemaSmokeText } from '../smoke-support';

describe('smoke support', () => {
  it('counts codex MCP tool calls as both tool use and tool result activity when completed', () => {
    const summary = summarizeToolActivity([
      { type: 'provider-item', payload: { type: 'mcp_tool_call', tool: 'shell', status: 'completed', result: { ok: true } } },
      { type: 'usage', payload: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ] as any);

    assert.strictEqual(summary.totalProviderItems, 1);
    assert.deepStrictEqual(summary.providerItemTypes, ['mcp_tool_call']);
    assert.strictEqual(summary.toolUseCount, 1);
    assert.strictEqual(summary.toolResultCount, 1);
  });

  it('counts Claude tool-progress and tool summaries as tool activity without overcounting non-tool items', () => {
    const summary = summarizeToolActivity([
      { type: 'provider-item', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } } },
      { type: 'provider-item', payload: { type: 'tool_progress', tool_name: 'Bash' } },
      { type: 'provider-item', payload: { type: 'tool_use_summary', summary: 'Used Bash to inspect files.' } },
    ] as any);

    assert.strictEqual(summary.totalProviderItems, 3);
    assert.deepStrictEqual(summary.providerItemTypes, ['assistant', 'tool_progress', 'tool_use_summary']);
    assert.strictEqual(summary.toolUseCount, 1);
    assert.strictEqual(summary.toolResultCount, 1);
  });

  it('covers failed/user/generic tool branches in the activity classifier', () => {
    const summary = summarizeToolActivity([
      { type: 'provider-item', payload: { type: 'mcp_tool_call', status: 'failed', error: { message: 'boom' } } },
      { type: 'provider-item', payload: { type: 'user', tool_use_result: { ok: true } } },
      { type: 'provider-item', payload: { type: 'tool_event' } },
    ] as any);

    assert.strictEqual(summary.toolUseCount, 2);
    assert.strictEqual(summary.toolResultCount, 2);
  });

  it('summarizes provider-item streaming traces for the adapted Claude smoke path', () => {
    const summary = summarizeProviderStreamActivity([
      { type: 'provider-item', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'pon' }] } } },
      { type: 'provider-item', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } } },
      { type: 'provider-item', payload: { type: 'result', subtype: 'success' } },
      { type: 'usage', payload: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ] as any);

    assert.strictEqual(summary.totalProviderItems, 3);
    assert.deepStrictEqual(summary.providerItemTypes, ['assistant', 'result']);
    assert.strictEqual(summary.assistantMessageCount, 2);
    assert.strictEqual(summary.resultMessageCount, 1);
    assert.deepStrictEqual(summary.assistantTextSnapshots, ['pon', 'pong']);
  });

  it('validates the donor-equivalent output-schema payload and reports malformed responses clearly', () => {
    assert.deepStrictEqual(validateOutputSchemaSmokeText('{"answer":"pong","letters":["p","o","n","g"],"count":4}'), {
      ok: true,
      payload: {
        answer: 'pong',
        letters: ['p', 'o', 'n', 'g'],
        count: 4,
      },
    });

    assert.deepStrictEqual(validateOutputSchemaSmokeText('{"answer":"pong","letters":"pong","count":4}'), {
      ok: false,
      reason: 'missing/invalid letters',
    });
    const malformed = validateOutputSchemaSmokeText('not json');
    assert.strictEqual(malformed.ok, false);
    if (malformed.ok) {
      throw new Error('expected malformed JSON to fail validation');
    }
    assert.match(malformed.reason, /not valid JSON/i);
  });

  it('rejects non-integer count values', () => {
    assert.deepStrictEqual(validateOutputSchemaSmokeText('{"answer":"pong","letters":["p","o","n","g"],"count":4.5}'), {
      ok: false,
      reason: 'missing/invalid count',
    });
  });
});