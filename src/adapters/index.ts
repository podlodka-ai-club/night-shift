import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { EventSink, Phase } from "../contracts/events.js";
import type { NightShiftConfig } from "../config/schema.js";
import { ClaudeAgentAdapter } from "./claude-agent.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter, AgentSession } from "./events.js";
import { instrumentSession } from "./instrumented.js";
import type {
  AgentAdapterFactory,
  AgentAdapterFactoryContext,
  AgentAdapterRegistry,
  AgentRole,
  ModelPricing,
  OpenSessionOptions,
} from "./types.js";

export { CodexAdapter } from "./codex.js";
export { ClaudeAgentAdapter } from "./claude-agent.js";
export { InMemoryFakeAdapter } from "./__test__/fake.js";
export { instrumentSession } from "./instrumented.js";
export { PRICING, computeCost } from "./pricing.js";
export * from "./types.js";
export * from "./events.js";

export interface CreateAgentOptions {
  role: AgentRole;
  phase: Phase;
  runId: string;
  ticketId: string;
  profileId: string;
  eventSink: EventSink;
  config: NightShiftConfig;
  /** Optional override used by tests to inject an in-memory adapter. */
  adapter?: AgentAdapter;
  pricingOverrides?: Readonly<Record<string, ModelPricing>>;
  /** Used to resolve relative `systemPromptFile` paths. Defaults to `process.cwd()`. */
  cwd?: string;
}

export const BUILTIN_ADAPTER_FACTORIES: AgentAdapterRegistry = Object.freeze({
  codex: ({ pricingOverrides }: AgentAdapterFactoryContext) =>
    new CodexAdapter(pricingOverrides ? { pricingOverrides } : {}),
  "claude-agent": () => new ClaudeAgentAdapter(),
});

export function createAdapterRegistry(
  config: Pick<NightShiftConfig, "adapterFactories">,
): AgentAdapterRegistry {
  const customFactories = config.adapterFactories ?? {};

  for (const provider of Object.keys(customFactories)) {
    if (provider in BUILTIN_ADAPTER_FACTORIES) {
      throw new Error(`createAgent: provider \"${provider}\" is reserved for a built-in adapter`);
    }
  }

  return Object.freeze({
    ...BUILTIN_ADAPTER_FACTORIES,
    ...customFactories,
  });
}

/**
 * Instantiates the correct adapter for the role, opens a session with the
 * configured model + system prompt, and wraps it for automatic
 * `AgentInvoked` emission.
 */
export async function createAgent(opts: CreateAgentOptions): Promise<AgentSession> {
  const roleConfig = opts.config.roles[opts.role];
  if (!roleConfig) {
    throw new Error(`createAgent: no role config for "${opts.role}"`);
  }
  const adapter = opts.adapter ?? createConfiguredAdapter(roleConfig.provider, opts.config, opts.pricingOverrides);

  let systemPrompt: string | undefined;
  if (roleConfig.systemPromptFile) {
    const cwd = opts.cwd ?? process.cwd();
    const filePath = isAbsolute(roleConfig.systemPromptFile)
      ? roleConfig.systemPromptFile
      : resolve(cwd, roleConfig.systemPromptFile);
    systemPrompt = await readFile(filePath, "utf8");
  }

  const sessionOptions: OpenSessionOptions = {
    role: opts.role,
    model: roleConfig.model,
    runId: opts.runId,
    ticketId: opts.ticketId,
    profileId: opts.profileId,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(roleConfig.providerOptions !== undefined
      ? { providerOptions: roleConfig.providerOptions as Record<string, unknown> }
      : {}),
  };

  const raw = adapter.openSession(sessionOptions);
  return instrumentSession(raw, {
    provider: adapter.provider,
    phase: opts.phase,
    sessionOptions,
    sink: opts.eventSink,
  });
}

export function createConfiguredAdapter(
  provider: string,
  config: Pick<NightShiftConfig, "adapterFactories" | "adapters">,
  pricingOverrides?: Readonly<Record<string, ModelPricing>>,
): AgentAdapter {
  const registry = createAdapterRegistry(config);
  const factory = registry[provider];

  if (!factory) {
    const available = Object.keys(registry).sort().join(", ");
    throw new Error(
      `createAgent: unknown provider \"${provider}\" (available: ${available})`,
    );
  }

  return factory({
    ...(config.adapters?.[provider] !== undefined
      ? { adapterConfig: config.adapters[provider] }
      : {}),
    ...(pricingOverrides !== undefined ? { pricingOverrides } : {}),
  });
}
