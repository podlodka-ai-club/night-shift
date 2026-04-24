import {
  AgentStreamEventSchema,
  type AgentInput,
  type AgentAdapter,
  type AgentSession,
  type AgentStreamEvent,
  type AgentThreadItem,
  type TurnOpts,
  type TurnResult,
} from "./events.js";
import { computeCost } from "./pricing.js";
import {
  OpenSessionOptionsSchema,
  type ModelPricing,
  type OpenSessionOptions,
  type TokenUsage,
} from "./types.js";

export interface ScriptedTurn {
  events: AgentStreamEvent[];
  finalText: string;
  usage: TokenUsage;
  /** Optional override. If absent, derived via `computeCost(model, usage, pricingOverrides)`. */
  cost?: number;
  items?: AgentThreadItem[];
  /** Optional minimum latency in ms (used to exercise timing-sensitive tests). */
  minLatencyMs?: number;
}

export interface InMemoryFakeAdapterOptions {
  script: ScriptedTurn[];
  pricingOverrides?: Readonly<Record<string, ModelPricing>>;
}

/**
 * Deterministic, in-process adapter used by tests across the codebase.
 * The script is shared across all sessions opened from this adapter so
 * tests can exercise sequential turns without orchestrating session state.
 */
export class InMemoryFakeAdapter implements AgentAdapter {
  readonly provider = "fake";
  private readonly queue: ScriptedTurn[];
  private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>;

  constructor(options: InMemoryFakeAdapterOptions) {
    this.queue = [...options.script];
    if (options.pricingOverrides) {
      this.pricingOverrides = options.pricingOverrides;
    }
  }

  openSession(opts: unknown): AgentSession {
    const parsed = OpenSessionOptionsSchema.parse(opts);
    return new FakeSession(this.queue, parsed, this.pricingOverrides);
  }
}

class FakeSession implements AgentSession {
  private _id: string | null = null;
  constructor(
    private readonly queue: ScriptedTurn[],
    private readonly opts: OpenSessionOptions,
    private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>,
  ) {}

  get id(): string | null {
    return this._id;
  }

  private nextTurn(): ScriptedTurn {
    const turn = this.queue.shift();
    if (!turn) {
      throw new Error(
        `InMemoryFakeAdapter: script exhausted (role=${this.opts.role}, model=${this.opts.model})`,
      );
    }
    return turn;
  }

  async run(_input: AgentInput, _opts?: TurnOpts): Promise<TurnResult> {
    const turn = this.nextTurn();
    const t0 = Date.now();
    // Emulate minimal latency; callers may rely on latencyMs > 0 for metrics.
    if (turn.minLatencyMs && turn.minLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, turn.minLatencyMs));
    }
    const latencyMs = Math.max(0, Date.now() - t0);
    this._id ??= "fake-session";
    const cost =
      turn.cost ?? computeCost(this.opts.model, turn.usage, this.pricingOverrides);
    return {
      finalText: turn.finalText,
      items: turn.items ?? [],
      usage: turn.usage,
      cost,
      latencyMs,
    };
  }

  async *runStreamed(
    _input: AgentInput,
    _opts?: TurnOpts,
  ): AsyncGenerator<AgentStreamEvent> {
    const turn = this.nextTurn();
    this._id ??= "fake-session";
    for (const ev of turn.events) {
      // Enforce the normalised vocabulary even in tests.
      AgentStreamEventSchema.parse(ev);
      yield ev;
    }
  }
}
