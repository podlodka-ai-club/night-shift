/**
 * Common interface for AI provider integrations.
 *
 * Each provider adapter handles SDK-specific invocation and returns
 * a uniform result so the AgentRunner can wrap it with budget/recording
 * logic exactly once.
 */
export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in USD, or 0 if not available. */
  costUsd: number;
}

export interface ProviderRunOptions {
  prompt: string;
  model: string;
  role: 'planner' | 'implementer' | 'reviewer';
  workingDirectory?: string;
  allowedTools?: string[];
  structuredOutputSchema?: Record<string, unknown>;
}

export interface ProviderAdapter {
  run(options: ProviderRunOptions): Promise<ProviderResult>;
}
