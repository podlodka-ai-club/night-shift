import {
  Codex,
  type CodexOptions,
  type ItemCompletedEvent,
  type ItemStartedEvent,
  type ItemUpdatedEvent,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { isAbsolute } from "node:path";
import {
  AgentStreamEventSchema,
  type AgentInput,
  type AgentAdapter,
  type AgentSession,
  type AgentStreamEvent,
  type AgentThreadItem,
  type ToolSource,
  type TurnOpts,
  type TurnResult,
} from "./events.js";
import { computeCost } from "./pricing.js";
import {
  OpenSessionOptionsSchema,
  type ModelPricing,
  type OpenSessionOptions,
} from "./types.js";

export interface CodexAdapterOptions {
  codexOptions?: CodexOptions;
  pricingOverrides?: Readonly<Record<string, ModelPricing>>;
  /**
   * Escape hatch for tests: provide a pre-built `Codex` client. When set,
   * `codexOptions` is ignored.
   */
  codexClient?: Pick<Codex, "startThread" | "resumeThread">;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex";
  private readonly options: CodexAdapterOptions;
  private _client: Pick<Codex, "startThread" | "resumeThread"> | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
    // No I/O in constructor — the SDK's `new Codex()` is cheap, but we still
    // defer instantiation until `openSession` to honour the adapter contract.
  }

  private client(): Pick<Codex, "startThread" | "resumeThread"> {
    if (this.options.codexClient) return this.options.codexClient;
    if (!this._client) this._client = new Codex(this.options.codexOptions);
    return this._client;
  }

  openSession(opts: unknown): AgentSession {
    const parsed = OpenSessionOptionsSchema.parse(opts);

    if (parsed.workingDirectory && !isAbsolute(parsed.workingDirectory)) {
      throw new Error(
        `CodexAdapter.openSession: workingDirectory must be absolute, got "${parsed.workingDirectory}"`,
      );
    }

    // Apply defaults; allow providerOptions to override.
    const providerOverrides = (parsed.providerOptions ?? {}) as Partial<ThreadOptions>;
    const threadOptions: ThreadOptions = {
      model: parsed.model,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      ...(parsed.workingDirectory ? { workingDirectory: parsed.workingDirectory } : {}),
      ...providerOverrides,
    };

    const thread = this.client().startThread(threadOptions);
    return new CodexSession(thread, parsed, this.options.pricingOverrides);
  }
}

class CodexSession implements AgentSession {
  private _id: string | null = null;

  constructor(
    private readonly thread: Thread,
    private readonly opts: OpenSessionOptions,
    private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>,
  ) {}

  get id(): string | null {
    return this._id ?? this.thread.id;
  }

  async run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult> {
    const t0 = Date.now();
    const turn = await this.thread.run(input, buildTurnOptions(opts));
    const latencyMs = Date.now() - t0;
    const usage = turn.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
    };
    const cost = computeCost(this.opts.model, usage, this.pricingOverrides);
    this._id = this.thread.id;
    return {
      finalText: turn.finalResponse,
      items: turn.items.map(threadItemToAgentItem),
      usage,
      cost,
      latencyMs,
    };
  }

  async *runStreamed(
    input: AgentInput,
    opts?: TurnOpts,
  ): AsyncGenerator<AgentStreamEvent> {
    const streamed = await this.thread.runStreamed(input, buildTurnOptions(opts));
    const translator = new EventTranslator(this.opts.model, this.pricingOverrides);
    for await (const raw of streamed.events) {
      for (const ev of translator.translate(raw)) {
        // Validate on the way out so bugs in translation are caught early
        // rather than silently emitted downstream.
        AgentStreamEventSchema.parse(ev);
        if (ev.kind === "session-started") {
          this._id = ev.sessionId;
        }
        yield ev;
      }
    }
  }
}

/** Stateful translator: buffers `agent_message` text to compute deltas. */
class EventTranslator {
  /** Last observed text per messageId, for delta computation. */
  private messageText = new Map<string, string>();
  /** Items we've already emitted `tool-use` for, keyed by item id. */
  private toolUseEmitted = new Set<string>();

  constructor(
    private readonly model: string,
    private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>,
  ) {}

  translate(raw: ThreadEvent): AgentStreamEvent[] {
    switch (raw.type) {
      case "thread.started":
        return [
          { kind: "session-started", sessionId: raw.thread_id, rawProviderEvent: raw },
        ];
      case "turn.started":
        return [{ kind: "turn-started", rawProviderEvent: raw }];
      case "turn.completed": {
        const cost = computeCost(this.model, raw.usage, this.pricingOverrides);
        return [
          {
            kind: "turn-completed",
            usage: raw.usage,
            cost,
            rawProviderEvent: raw,
          },
        ];
      }
      case "turn.failed":
        return [
          {
            kind: "turn-failed",
            error: { message: raw.error.message },
            rawProviderEvent: raw,
          },
        ];
      case "error":
        return [
          {
            kind: "turn-failed",
            error: { message: raw.message },
            rawProviderEvent: raw,
          },
        ];
      case "item.started":
        return this.handleItem(raw, "started");
      case "item.updated":
        return this.handleItem(raw, "updated");
      case "item.completed":
        return this.handleItem(raw, "completed");
      default:
        return [];
    }
  }

  private handleItem(
    ev: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent,
    stage: "started" | "updated" | "completed",
  ): AgentStreamEvent[] {
    const item = ev.item;
    const out: AgentStreamEvent[] = [];
    switch (item.type) {
      case "agent_message": {
        if (stage === "started") {
          this.messageText.set(item.id, "");
          // nothing to emit until we see content
          return [];
        }
        const prev = this.messageText.get(item.id) ?? "";
        const curr = item.text ?? "";
        if (stage === "updated") {
          if (curr.length > prev.length) {
            const delta = curr.slice(prev.length);
            this.messageText.set(item.id, curr);
            out.push({
              kind: "text-delta",
              messageId: item.id,
              text: delta,
              rawProviderEvent: ev,
            });
          }
          return out;
        }
        // completed
        if (curr.length > prev.length) {
          const delta = curr.slice(prev.length);
          out.push({
            kind: "text-delta",
            messageId: item.id,
            text: delta,
            rawProviderEvent: ev,
          });
        }
        this.messageText.set(item.id, curr);
        out.push({
          kind: "message-completed",
          messageId: item.id,
          text: curr,
          rawProviderEvent: ev,
        });
        return out;
      }
      case "reasoning": {
        if (stage === "completed") {
          return [{ kind: "reasoning", text: item.text, rawProviderEvent: ev }];
        }
        return [];
      }
      case "command_execution": {
        return this.toolItem(
          ev,
          item.id,
          item.command,
          { command: item.command },
          { kind: "shell" },
          stage,
          item.status === "completed"
            ? "completed"
            : item.status === "failed"
              ? "failed"
              : undefined,
          {
            aggregated_output: item.aggregated_output,
            exit_code: item.exit_code,
          },
        );
      }
      case "file_change": {
        return this.toolItem(
          ev,
          item.id,
          "file-change",
          { changes: item.changes },
          { kind: "file-change" },
          stage,
          item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : undefined,
          { changes: item.changes },
        );
      }
      case "mcp_tool_call": {
        return this.toolItem(
          ev,
          item.id,
          item.tool,
          item.arguments,
          { kind: "mcp", server: item.server },
          stage,
          item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : undefined,
          item.result ?? item.error ?? null,
        );
      }
      case "web_search": {
        return this.toolItem(
          ev,
          item.id,
          "web-search",
          { query: item.query },
          { kind: "web-search" },
          stage,
          stage === "completed" ? "completed" : undefined,
          null,
        );
      }
      case "todo_list": {
        return this.toolItem(
          ev,
          item.id,
          "todo-list",
          { items: item.items },
          { kind: "todo" },
          stage,
          stage === "completed" ? "completed" : undefined,
          item.items,
        );
      }
      case "error": {
        return [{ kind: "warning", message: item.message, rawProviderEvent: ev }];
      }
      default:
        return [];
    }
  }

  private toolItem(
    ev: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent,
    id: string,
    tool: string,
    input: unknown,
    source: ToolSource,
    stage: "started" | "updated" | "completed",
    terminalStatus: "completed" | "failed" | undefined,
    resultPayload: unknown,
  ): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = [];
    if (stage !== "completed" && !this.toolUseEmitted.has(id)) {
      out.push({
        kind: "tool-use",
        toolCallId: id,
        tool,
        input,
        source,
        rawProviderEvent: ev,
      });
      this.toolUseEmitted.add(id);
    }
    if (stage === "completed") {
      if (!this.toolUseEmitted.has(id)) {
        out.push({
          kind: "tool-use",
          toolCallId: id,
          tool,
          input,
          source,
          rawProviderEvent: ev,
        });
        this.toolUseEmitted.add(id);
      }
      out.push({
        kind: "tool-result",
        toolCallId: id,
        status: terminalStatus ?? "completed",
        output: resultPayload,
        rawProviderEvent: ev,
      });
    }
    return out;
  }
}

function threadItemToAgentItem(i: ThreadItem): AgentThreadItem {
  return { id: i.id, type: i.type, payload: i };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveLocalSchemaRef(
  rootSchema: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = rootSchema;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return isRecord(current) ? current : undefined;
}

function normalizeOutputSchema(outputSchema: unknown): unknown {
  if (!isRecord(outputSchema)) {
    return outputSchema;
  }

  let normalized = outputSchema;
  if (typeof normalized.type !== "string" && typeof normalized.$ref === "string") {
    const resolved = resolveLocalSchemaRef(normalized, normalized.$ref);
    if (resolved) {
      normalized = resolved;
    }
  }

  if (!("$schema" in normalized)) {
    return normalized;
  }

  const { $schema: _ignored, ...withoutMeta } = normalized;
  return withoutMeta;
}

function buildTurnOptions(opts?: TurnOpts): {
  outputSchema?: unknown;
  signal?: AbortSignal;
} {
  const out: { outputSchema?: unknown; signal?: AbortSignal } = {};
  if (opts?.outputSchema !== undefined) {
    out.outputSchema = normalizeOutputSchema(opts.outputSchema);
  }
  if (opts?.signal) out.signal = opts.signal;
  return out;
}
