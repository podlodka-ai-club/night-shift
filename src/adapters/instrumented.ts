import type { EventSink, Phase } from "../contracts/events.js";
import type {
  AgentInput,
  AgentSession,
  AgentStreamEvent,
  TurnOpts,
  TurnResult,
} from "./events.js";
import type { OpenSessionOptions, TokenUsage } from "./types.js";

/**
 * Context needed to emit `AgentInvoked` events. The `phase` is not carried
 * on the session options because `role="subagent"` can be invoked from any
 * phase; callers pass the phase explicitly at wrap time.
 */
export interface InstrumentationContext {
  provider: string;
  phase: Phase;
  sessionOptions: OpenSessionOptions;
  sink: EventSink;
  now?: () => Date;
}

/**
 * Wraps an AgentSession so that every `run` / `runStreamed` call automatically
 * emits a single `AgentInvoked` event through the provided sink. The event is
 * emitted on completion (success OR failure) via try/finally so callers that
 * break out of a stream early still record the invocation.
 */
export function instrumentSession(
  session: AgentSession,
  ctx: InstrumentationContext,
): AgentSession {
  const now = ctx.now ?? (() => new Date());
  const { provider, phase, sessionOptions, sink } = ctx;
  const { role, model, runId, ticketId, profileId } = sessionOptions;

  async function emit(cost: number, usage: TokenUsage, latencyMs: number) {
    await sink.emit({
      kind: "AgentInvoked",
      ticketId,
      phase,
      profileId,
      ts: now().toISOString(),
      runId,
      role,
      provider,
      model,
      cost,
      tokens: { input: usage.input_tokens, output: usage.output_tokens },
      latencyMs,
    });
  }

  return {
    get id() {
      return session.id;
    },
    async run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult> {
      const t0 = Date.now();
      try {
        const result = await session.run(input, opts);
        await emit(result.cost, result.usage, result.latencyMs);
        return result;
      } catch (err) {
        const latencyMs = Date.now() - t0;
        await emit(
          0,
          { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
          latencyMs,
        );
        throw err;
      }
    },
    async *runStreamed(
      input: AgentInput,
      opts?: TurnOpts,
    ): AsyncGenerator<AgentStreamEvent> {
      const t0 = Date.now();
      let lastUsage: TokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
      };
      let lastCost = 0;
      let emitted = false;
      try {
        for await (const ev of session.runStreamed(input, opts)) {
          if (ev.kind === "turn-completed") {
            lastUsage = ev.usage;
            lastCost = ev.cost;
          }
          yield ev;
        }
      } finally {
        if (!emitted) {
          emitted = true;
          const latencyMs = Date.now() - t0;
          await emit(lastCost, lastUsage, latencyMs);
        }
      }
    },
    ...(session.close ? { close: () => session.close!() } : {}),
  };
}
