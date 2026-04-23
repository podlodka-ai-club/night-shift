import { Codex } from '@openai/codex-sdk';
import type { ProviderAdapter, ProviderRunOptions, ProviderResult } from './ProviderAdapter.js';

/**
 * Codex SDK provider adapter.
 *
 * Maps role to sandboxMode: implementer gets workspace-write, others read-only.
 * Structured output is passed via the SDK's `outputSchema` option.
 */
export class CodexAdapter implements ProviderAdapter {
  constructor(private readonly apiKey: string) {}

  async run(options: ProviderRunOptions): Promise<ProviderResult> {
    const codex = new Codex({ apiKey: this.apiKey });
    const thread = codex.startThread({
      model: options.model,
      approvalPolicy: 'never',
      sandboxMode: options.role === 'implementer' ? 'workspace-write' : 'read-only',
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    });

    const result = await thread.run(options.prompt, {
      ...(options.structuredOutputSchema ? { outputSchema: options.structuredOutputSchema } : {}),
    });

    return {
      text: result.finalResponse,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      costUsd: 0,
    };
  }
}
