export const AGENT_PROVIDERS = ['codex', 'claude'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface RequestedAgentProviderConfig {
  model?: string;
  [key: string]: unknown;
}

export interface RequestedAgentProviderSelection {
  provider?: string;
  config?: RequestedAgentProviderConfig;
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

const AGENT_PROVIDER_ALIASES = Object.freeze({
  codex: 'codex',
  openai: 'codex',
  claude: 'claude',
  'claude-agent': 'claude',
  anthropic: 'claude',
} satisfies Record<string, AgentProvider>);

export function normalizeAgentProvider(value: string | undefined): AgentProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const aliasedProvider = AGENT_PROVIDER_ALIASES[normalized as keyof typeof AGENT_PROVIDER_ALIASES];
  if (aliasedProvider) {
    return aliasedProvider;
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
  const requestedModel = typeof request.config?.model === 'string' ? request.config.model : undefined;

  const inferredProvider = inferAgentProviderFromModel(requestedModel);
  const provider = explicitProvider ?? inferredProvider ?? DEFAULT_AGENT_PROVIDER;
  if (explicitProvider && inferredProvider && explicitProvider !== inferredProvider) {
    throw new Error(`Model "${requestedModel}" does not match provider "${explicitProvider}".`);
  }

  return {
    provider,
    model: requestedModel?.trim() || DEFAULT_AGENT_MODEL_BY_PROVIDER[provider],
  };
}