import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderAdapter, ProviderRunOptions, ProviderResult } from './ProviderAdapter.js';
import { StructuredOutputError } from '../types.js';

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

/**
 * Claude Agent SDK provider adapter.
 *
 * Streams agent messages and collects the final success result.
 * Structured output is mapped to `outputFormat: { type: 'json_schema' }`.
 */
export class ClaudeAdapter implements ProviderAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly defaultCwd: string,
  ) {}

  async run(options: ProviderRunOptions): Promise<ProviderResult> {
    const allowedTools = options.allowedTools ?? DEFAULT_ALLOWED_TOOLS;

    const stream = claudeQuery({
      prompt: options.prompt,
      options: {
        cwd: options.workingDirectory ?? this.defaultCwd,
        allowedTools,
        tools: allowedTools,
        env: {
          ...process.env as Record<string, string>,
          ANTHROPIC_API_KEY: this.apiKey,
        },
        model: options.model,
        ...(options.structuredOutputSchema
          ? { outputFormat: { type: 'json_schema' as const, schema: options.structuredOutputSchema } }
          : {}),
      },
    });

    let resultText = '';
    let totalCostUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawSuccess = false;

    for await (const message of stream) {
      if (message.type === 'result' && message.subtype === 'success') {
        sawSuccess = true;
        totalCostUsd = message.total_cost_usd ?? 0;
        inputTokens = message.usage?.input_tokens ?? 0;
        outputTokens = message.usage?.output_tokens ?? 0;

        if (options.structuredOutputSchema) {
          if (message.structured_output === undefined) {
            throw new StructuredOutputError('Claude agent did not return structured output');
          }
          resultText = JSON.stringify(message.structured_output, null, 2);
        } else {
          resultText = message.result;
        }
      }
    }

    if (!sawSuccess) {
      throw new Error(`Claude agent invocation did not complete successfully`);
    }

    return {
      text: resultText,
      inputTokens,
      outputTokens,
      costUsd: totalCostUsd,
    };
  }
}
