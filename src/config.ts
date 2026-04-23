import 'dotenv/config';
import { z } from 'zod';

const AgentProviderSchema = z.enum(['codex', 'anthropic']);

const AgentRoleConfigSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string().min(1),
});

const AgentsSchema = z.object({
  planner: AgentRoleConfigSchema,
  implementer: AgentRoleConfigSchema,
  reviewer: AgentRoleConfigSchema,
});

export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentRoleConfig = z.infer<typeof AgentRoleConfigSchema>;
export type AgentRole = keyof z.infer<typeof AgentsSchema>;

const StatusValuesSchema = z.object({
  ready: z.string().default('Ready'),
  inProgress: z.string().default('In progress'),
  inReview: z.string().default('In review'),
  blocked: z.string().default('Blocked'),
});

const BudgetsSchema = z.object({
  specify: z.number().default(0.5),
  implement: z.number().default(2.0),
  review: z.number().default(0.5),
  totalPerTicket: z.number().default(5.0),
});

const ModelPricingSchema = z.object({
  inputPer1kTokens: z.number(),
  outputPer1kTokens: z.number(),
});

const AGENT_DEFAULTS = {
  planner: { provider: 'codex', model: 'gpt-5-mini' },
  implementer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  reviewer: { provider: 'codex', model: 'gpt-5-mini' },
} satisfies z.infer<typeof AgentsSchema>;

const PRICING_DEFAULTS = {
  codex: { inputPer1kTokens: 0.00075, outputPer1kTokens: 0.0045 },
  anthropic: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  sonnet: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  modelOverrides: {
    'codex:gpt-5.1-codex-mini': {
      inputPer1kTokens: 0.00075,
      outputPer1kTokens: 0.0045,
    },
  },
} satisfies {
  codex: z.infer<typeof ModelPricingSchema>;
  anthropic: z.infer<typeof ModelPricingSchema>;
  sonnet: z.infer<typeof ModelPricingSchema>;
  modelOverrides: Record<string, z.infer<typeof ModelPricingSchema>>;
};

const PricingSchema = z.object({
  // Provider defaults.
  codex: ModelPricingSchema.default(PRICING_DEFAULTS.codex),
  anthropic: ModelPricingSchema.default(PRICING_DEFAULTS.anthropic),
  // Legacy alias retained for backward compatibility with existing callers.
  sonnet: ModelPricingSchema.default(PRICING_DEFAULTS.sonnet),
  modelOverrides: z.record(z.string(), ModelPricingSchema).default({}),
});

// Explicit defaults for nested object schemas (required by zod v4 type inference
// — the .default() argument must match the schema's full output type).
const STATUS_DEFAULTS = {
  ready: 'Ready',
  inProgress: 'In progress',
  inReview: 'In review',
  blocked: 'Blocked',
} satisfies z.infer<typeof StatusValuesSchema>;

const BUDGETS_DEFAULTS = {
  specify: 0.5,
  implement: 2.0,
  review: 0.5,
  totalPerTicket: 5.0,
} satisfies z.infer<typeof BudgetsSchema>;

const ConfigSchema = z.object({
  github: z.object({
    token: z.string().min(1),
    projectOwner: z.string().min(1),
    projectOwnerType: z.enum(['user', 'org']).default('user'),
    projectNumber: z.coerce.number().int().positive(),
    repoOwner: z.string().min(1),
    repoName: z.string().min(1),
    defaultBranch: z.string().default('main'),
    statusFieldName: z.string().default('Status'),
    statusValues: StatusValuesSchema.default(STATUS_DEFAULTS),
  }),
  anthropic: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('claude-sonnet-4-6'),
  }),
  codex: z.object({
    enabled: z.boolean().default(true),
    apiKey: z.string().optional(),
    model: z.string().default('gpt-5-mini'),
  }).default({ enabled: true, model: 'gpt-5-mini' }),
  agents: AgentsSchema,
  budgets: BudgetsSchema.default(BUDGETS_DEFAULTS),
  pricing: PricingSchema.default(PRICING_DEFAULTS),
  /**
   * Output settings.
   *
   * `output.runSummary.format` controls the format of the run summary printed
   * on terminal state. Allowed values: "pretty" | "json" | "none".
   * Defaults to auto-detection (TTY → "pretty", CI → "json").
   */
  output: z.object({
    runSummary: z.object({
      format: z.enum(['pretty', 'json', 'none']).optional(),
    }).default({}),
  }).default({ runSummary: {} }),
  dataDir: z.string().default('./data/runs'),
  repoDir: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

function resolveLegacyModel(provider: AgentProvider): string | undefined {
  return provider === 'codex'
    ? process.env.CODEX_MODEL
    : process.env.ANTHROPIC_MODEL;
}

function resolveAgentConfig(role: AgentRole): AgentRoleConfig {
  const providerEnvKey = `AGENT_${role.toUpperCase()}_PROVIDER`;
  const modelEnvKey = `AGENT_${role.toUpperCase()}_MODEL`;
  const provider = (process.env[providerEnvKey] ?? AGENT_DEFAULTS[role].provider) as AgentProvider;

  return {
    provider,
    model: process.env[modelEnvKey] ?? resolveLegacyModel(provider) ?? AGENT_DEFAULTS[role].model,
  };
}

export function loadConfig(): Config {
  return ConfigSchema.parse({
    github: {
      token: process.env.GITHUB_TOKEN,
      projectOwner: process.env.GITHUB_PROJECT_OWNER,
      projectOwnerType: process.env.GITHUB_PROJECT_OWNER_TYPE,
      projectNumber: process.env.GITHUB_PROJECT_NUMBER,
      repoOwner: process.env.GITHUB_REPO_OWNER,
      repoName: process.env.GITHUB_REPO_NAME,
      defaultBranch: process.env.GITHUB_DEFAULT_BRANCH,
      statusFieldName: process.env.GITHUB_STATUS_FIELD_NAME,
      statusValues: {
        ready: process.env.GITHUB_STATUS_READY,
        inProgress: process.env.GITHUB_STATUS_IN_PROGRESS,
        inReview: process.env.GITHUB_STATUS_IN_REVIEW,
        blocked: process.env.GITHUB_STATUS_BLOCKED,
      },
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    },
    codex: {
      enabled: process.env.CODEX_ENABLED !== 'false',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.CODEX_MODEL,
    },
    agents: {
      planner: resolveAgentConfig('planner'),
      implementer: resolveAgentConfig('implementer'),
      reviewer: resolveAgentConfig('reviewer'),
    },
    budgets: {
      specify: process.env.BUDGET_SPECIFY ? Number(process.env.BUDGET_SPECIFY) : undefined,
      implement: process.env.BUDGET_IMPLEMENT ? Number(process.env.BUDGET_IMPLEMENT) : undefined,
      review: process.env.BUDGET_REVIEW ? Number(process.env.BUDGET_REVIEW) : undefined,
      totalPerTicket: process.env.BUDGET_TOTAL ? Number(process.env.BUDGET_TOTAL) : undefined,
    },
    output: {
      runSummary: {
        format: process.env.SUMMARY_FORMAT as 'pretty' | 'json' | 'none' | undefined,
      },
    },
    dataDir: process.env.DATA_DIR,
    repoDir: process.env.REPO_DIR,
  });
}
