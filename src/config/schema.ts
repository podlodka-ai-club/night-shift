import { z } from "zod";
import { AgentRoleSchema } from "../adapters/types.js";

export const ProviderSchema = z.enum(["codex", "claude-agent"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRoleConfigSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  systemPromptFile: z.string().min(1).optional(),
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
});

export const NightShiftConfigSchema = z.object({
  roles: z.record(AgentRoleSchema, AgentRoleConfigSchema),
  qualityGates: QualityGatesConfigSchema.optional(),
  adapters: AdaptersConfigSchema.optional(),
});
export type NightShiftConfig = z.infer<typeof NightShiftConfigSchema>;

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
