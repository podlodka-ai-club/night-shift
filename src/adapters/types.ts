import { z } from "zod";
import type { AgentAdapter } from "./events.js";

/**
 * Closed set of agent roles. New roles require a code change, not config.
 * Extensibility for M3 will be a separate, deliberate schema change.
 */
export const AgentRoleSchema = z.enum([
  "specifier",
  "implementer",
  "reviewer",
  "subagent",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const BUILTIN_ADAPTER_IDS = ["codex", "claude-agent"] as const;
export type BuiltInAdapterId = (typeof BUILTIN_ADAPTER_IDS)[number];

export function isBuiltInAdapterId(value: string): value is BuiltInAdapterId {
  return (BUILTIN_ADAPTER_IDS as readonly string[]).includes(value);
}

/**
 * Token usage as reported by a provider turn.
 * Field names mirror Codex SDK's `Usage` type for easy passthrough.
 */
export const TokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Per-model pricing. Values are decimal USD per 1M tokens.
 * `cachedInputPer1M` is optional; when absent, cached tokens use `inputPer1M`.
 */
export const ModelPricingSchema = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  cachedInputPer1M: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export interface AgentAdapterFactoryContext {
  adapterConfig?: unknown;
  pricingOverrides?: Readonly<Record<string, ModelPricing>>;
}

export type AgentAdapterFactory = (context: AgentAdapterFactoryContext) => AgentAdapter;
export type AgentAdapterRegistry = Readonly<Record<string, AgentAdapterFactory>>;

/**
 * Options for opening a session. The observability fields (runId, ticketId,
 * profileId) are required so every AgentInvoked event is correlatable.
 *
 * `workingDirectory`, when provided, MUST be absolute. Sessions must not
 * accept relative paths at this layer — phase code is responsible for
 * resolving them.
 */
export const OpenSessionOptionsSchema = z.object({
  role: AgentRoleSchema,
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  workingDirectory: z.string().optional(),
  runId: z.string().min(1),
  ticketId: z.string().min(1),
  profileId: z.string().min(1),
  providerOptions: z.unknown().optional(),
});
export type OpenSessionOptions = z.infer<typeof OpenSessionOptionsSchema>;
