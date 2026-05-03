export const AGENT_PROVIDERS = ['codex', 'claude'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface RequestedAgentProviderSelection {
  provider?: string;
  model?: string;
}

export interface AgentProviderSelection {
  provider: AgentProvider;
  model: string;
}

export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'codex';

export const DEFAULT_AGENT_MODEL_BY_PROVIDER: Readonly<Record<AgentProvider, string>> = Object.freeze({
  codex: 'gpt-5.3-codex',
  claude: 'claude-sonnet-4-6',
});

export function normalizeAgentProvider(value: string | undefined): AgentProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'codex') {
    return 'codex';
  }
  if (normalized === 'claude' || normalized === 'claude-agent') {
    return 'claude';
  }
  throw new Error(`Unsupported provider "${value}". Supported providers: ${AGENT_PROVIDERS.join(', ')}`);
}

export function inferAgentProviderFromModel(model: string | undefined): AgentProvider | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('claude')) {
    return 'claude';
  }
  if (normalized.includes('codex') || normalized.startsWith('gpt-')) {
    return 'codex';
  }
  return undefined;
}

export function resolveAgentProviderSelection(
  request: RequestedAgentProviderSelection = {},
): AgentProviderSelection {
  const explicitProvider = request.provider === undefined ? undefined : normalizeAgentProvider(request.provider);

  const inferredProvider = inferAgentProviderFromModel(request.model);
  const provider = explicitProvider ?? inferredProvider ?? DEFAULT_AGENT_PROVIDER;
  if (explicitProvider && inferredProvider && explicitProvider !== inferredProvider) {
    throw new Error(`Model "${request.model}" does not match provider "${explicitProvider}".`);
  }

  return {
    provider,
    model: request.model?.trim() || DEFAULT_AGENT_MODEL_BY_PROVIDER[provider],
  };
}