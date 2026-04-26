import { z } from "zod";
import type { AgentAdapterFactory } from "../adapters/types.js";
import { AgentRoleSchema } from "../adapters/types.js";
import { GitHubConfigSchema } from "../github/types.js";

export const ProviderSchema = z.string().min(1);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRoleConfigSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  systemPromptFile: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  providerOptions: z.unknown().optional(),
});
export type AgentRoleConfig = z.infer<typeof AgentRoleConfigSchema>;

export const QualityGatesConfigSchema = z
  .object({
    typecheck: z.boolean().optional(),
    lint: z.boolean().optional(),
    test: z.boolean().optional(),
  })
  .catchall(z.unknown());
export type QualityGatesConfig = z.infer<typeof QualityGatesConfigSchema>;

export const CodexAdapterConfigSchema = z
  .object({
    codexPathOverride: z.string().optional(),
    baseUrl: z.string().optional(),
  })
  .catchall(z.unknown());

export const AdaptersConfigSchema = z.object({
  codex: CodexAdapterConfigSchema.optional(),
}).catchall(z.unknown());

export const ReviewPhaseConfigSchema = z.object({
  maxDiffBytes: z.number().int().positive().default(65536),
  escalationLabel: z.string().min(1).default("night-shift:escalation"),
});
export type ReviewPhaseConfig = z.infer<typeof ReviewPhaseConfigSchema>;

export const TemporalConfigSchema = z.object({
  serverUrl: z.string().min(1).default("localhost:7233"),
  namespace: z.string().min(1).default("default"),
  taskQueue: z.string().min(1).default("night-shift"),
});
export type TemporalConfig = z.infer<typeof TemporalConfigSchema>;

const VALID_INTERVAL_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] as const;

export const PickupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVAL_MINUTES as readonly number[]).includes(v), {
      message: `intervalMinutes must be a divisor of 60: ${VALID_INTERVAL_MINUTES.join(", ")}`,
    })
    .default(5),
  maxConcurrent: z.number().int().min(1).default(5),
});
export type PickupConfig = z.infer<typeof PickupConfigSchema>;

export const NightShiftConfigSchema = z.object({
  roles: z.record(AgentRoleSchema, AgentRoleConfigSchema),
  repoRoot: z.string().min(1).optional(),
  qualityGates: QualityGatesConfigSchema.optional(),
  adapters: AdaptersConfigSchema.optional(),
  github: GitHubConfigSchema.optional(),
  reviewPhase: ReviewPhaseConfigSchema.optional(),
  temporal: TemporalConfigSchema.default({}),
  pickup: PickupConfigSchema.optional(),
});
export type NightShiftConfig = z.input<typeof NightShiftConfigSchema> & {
  adapterFactories?: Readonly<Record<string, AgentAdapterFactory>>;
};
export type ResolvedNightShiftConfig = z.infer<typeof NightShiftConfigSchema> & {
  adapterFactories?: Readonly<Record<string, AgentAdapterFactory>>;
};

export function defineNightShiftConfig<T extends NightShiftConfig>(config: T): T {
  return config;
}

/**
 * Default configuration used when no `night-shift.config.*` file is found.
 * All roles use Codex with `gpt-5.4` by default; callers are expected to
 * override the reviewer to a cheaper model in their own config.
 */
export const DEFAULT_CONFIG: NightShiftConfig = Object.freeze({
  roles: {
    specifier: { provider: "codex", model: "gpt-5.4" },
    implementer: { provider: "codex", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    subagent: { provider: "codex", model: "gpt-5.4" },
  },
}) as NightShiftConfig;
