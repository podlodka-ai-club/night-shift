import { z } from "zod";
import { TokenUsageSchema } from "./types.js";

/**
 * Source of a tool-use call. Discriminated so we retain provider-specific
 * metadata where it matters (MCP server name) without leaking raw shapes.
 */
export const ToolSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell") }),
  z.object({ kind: z.literal("file-change") }),
  z.object({ kind: z.literal("web-search") }),
  z.object({ kind: z.literal("mcp"), server: z.string().min(1) }),
  z.object({ kind: z.literal("todo") }),
  z.object({ kind: z.literal("other"), name: z.string().min(1) }),
]);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

const RawProviderEvent = z
  .object({ rawProviderEvent: z.unknown() })
  .partial();

/**
 * Normalised, provider-agnostic event vocabulary.
 * See design.md "Normalised streamed event shape" for the rationale.
 */
export const AgentStreamEventSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("session-started"), sessionId: z.string().min(1) })
    .merge(RawProviderEvent),
  z.object({ kind: z.literal("turn-started") }).merge(RawProviderEvent),
  z
    .object({
      kind: z.literal("text-delta"),
      messageId: z.string().min(1),
      text: z.string(),
    })
    .merge(RawProviderEvent),
  z
    .object({
      kind: z.literal("message-completed"),
      messageId: z.string().min(1),
      text: z.string(),
    })
    .merge(RawProviderEvent),
  z
    .object({ kind: z.literal("reasoning"), text: z.string() })
    .merge(RawProviderEvent),
  // `source.kind` is the canonical category for cross-adapter aggregation
  // (e.g. "show all shell calls"). `tool` is the most-specific identifier the
  // provider exposes within that category and is shaped by the provider's
  // tool catalog: Claude returns the SDK tool name ("Bash", "Glob", "Edit",
  // "Read"); Codex shell calls return the command string itself, since
  // `command_execution` is the only shell tool and the command is the only
  // discriminator between calls. Do NOT filter on `tool` across providers —
  // use `source.kind` for that.
  z
    .object({
      kind: z.literal("tool-use"),
      toolCallId: z.string().min(1),
      tool: z.string().min(1),
      input: z.unknown(),
      source: ToolSourceSchema,
    })
    .merge(RawProviderEvent),
  z
    .object({
      kind: z.literal("tool-result"),
      toolCallId: z.string().min(1),
      status: z.enum(["completed", "failed"]),
      output: z.unknown(),
    })
    .merge(RawProviderEvent),
  z
    .object({
      kind: z.literal("turn-completed"),
      usage: TokenUsageSchema,
      cost: z.number().int().nonnegative(),
    })
    .merge(RawProviderEvent),
  z
    .object({
      kind: z.literal("turn-failed"),
      error: z.object({ message: z.string() }),
    })
    .merge(RawProviderEvent),
  z
    .object({ kind: z.literal("warning"), message: z.string() })
    .merge(RawProviderEvent),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/**
 * A raw thread item captured for TurnResult. We keep them opaque (`unknown`)
 * to avoid hard-coupling to any provider's item schema; phase code should
 * rely on the normalised stream events for decision-making.
 */
export const AgentThreadItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
});
export type AgentThreadItem = z.infer<typeof AgentThreadItemSchema>;

export const TurnResultSchema = z.object({
  finalText: z.string(),
  items: z.array(AgentThreadItemSchema),
  usage: TokenUsageSchema,
  cost: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export type TurnResult = z.infer<typeof TurnResultSchema>;

/** Turn options surfaced by the adapter. Subset of what providers offer. */
export interface TurnOpts {
  /** Optional JSON Schema for structured output (passed through to provider). */
  outputSchema?: unknown;
  /** AbortSignal to cancel the turn. */
  signal?: AbortSignal;
}

/** Text or text-with-images input. For M1 we only accept string. */
export type AgentInput = string;

/**
 * Multi-turn session with an agent. Provider-agnostic.
 *
 * - `run` returns after the turn completes (resolved promise).
 * - `runStreamed` yields events in real time; implementations MUST end with
 *   either `turn-completed` or `turn-failed`.
 * - `close` is optional; adapters may use it to release resources (e.g. kill
 *   the underlying Codex subprocess). Phase code should call it in a
 *   `finally` block when done with the session.
 */
export interface AgentSession {
  readonly id: string | null;
  run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult>;
  runStreamed(input: AgentInput, opts?: TurnOpts): AsyncIterable<AgentStreamEvent>;
  close?(): Promise<void>;
}

/**
 * Provider-agnostic adapter. Implementations MUST NOT perform I/O in their
 * constructor; side-effects happen only at `openSession` / `run`.
 */
export interface AgentAdapter {
  readonly provider: string;
  openSession(opts: unknown): AgentSession;
}
