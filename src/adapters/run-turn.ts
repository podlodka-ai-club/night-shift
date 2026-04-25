import type {
  AgentInput,
  AgentSession,
  AgentStreamEvent,
  TurnOpts,
  TurnResult,
} from "./events.js";
import type { TokenUsage } from "./types.js";

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
};

export async function runTurnWithProgress(
  session: AgentSession,
  input: AgentInput,
  opts: TurnOpts | undefined,
  onEvent?: ((event: AgentStreamEvent) => Promise<void> | void),
): Promise<TurnResult> {
  if (!onEvent) {
    return session.run(input, opts);
  }

  const startedAt = Date.now();
  let finalText = "";
  let usage: TokenUsage = ZERO_USAGE;
  let cost = 0;

  for await (const event of session.runStreamed(input, opts)) {
    await onEvent(event);

    switch (event.kind) {
      case "text-delta":
        finalText += event.text;
        break;
      case "message-completed":
        finalText = event.text;
        break;
      case "turn-completed":
        usage = event.usage;
        cost = event.cost;
        break;
      case "turn-failed":
        throw new Error(event.error.message);
      default:
        break;
    }
  }

  return {
    finalText,
    items: [],
    usage,
    cost,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}