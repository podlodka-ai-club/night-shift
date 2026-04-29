import {
  query,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultError,
  type SDKResultSuccess,
  type SDKUserMessage,
  type NonNullableUsage,
} from "@anthropic-ai/claude-agent-sdk";
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
  type TokenUsage,
} from "./types.js";

export type ClaudeQueryFn = typeof query;

export interface ClaudeAgentAdapterOptions {
  pricingOverrides?: Readonly<Record<string, ModelPricing>>;
  /**
   * Escape hatch for tests: provide an alternative `query` implementation.
   * When set, the SDK's exported `query` is bypassed.
   */
  queryFn?: ClaudeQueryFn;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly provider = "claude-agent";
  private readonly options: ClaudeAgentAdapterOptions;

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.options = options;
  }

  openSession(opts: unknown): AgentSession {
    const parsed = OpenSessionOptionsSchema.parse(opts);

    if (parsed.workingDirectory && !isAbsolute(parsed.workingDirectory)) {
      throw new Error(
        `ClaudeAgentAdapter.openSession: workingDirectory must be absolute, got "${parsed.workingDirectory}"`,
      );
    }

    return new ClaudeAgentSession(
      this.options.queryFn ?? query,
      parsed,
      this.options.pricingOverrides,
    );
  }
}

class ClaudeAgentSession implements AgentSession {
  private _id: string | null = null;

  constructor(
    private readonly queryFn: ClaudeQueryFn,
    private readonly opts: OpenSessionOptions,
    private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>,
  ) {}

  get id(): string | null {
    return this._id;
  }

  private buildOptions(turnOpts?: TurnOpts): Options {
    const base: Options = {
      model: this.opts.model,
      // Match Codex defaults: workspace-write + no approval prompts.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    if (this.opts.workingDirectory) base.cwd = this.opts.workingDirectory;
    if (this.opts.systemPrompt !== undefined) {
      base.systemPrompt = this.opts.systemPrompt;
    }
    if (this._id) {
      base.resume = this._id;
    }
    if (turnOpts?.outputSchema !== undefined) {
      base.outputFormat = {
        type: "json_schema",
        schema: turnOpts.outputSchema as Record<string, unknown>,
      };
    }
    if (turnOpts?.signal) {
      const ac = new AbortController();
      if (turnOpts.signal.aborted) ac.abort();
      else turnOpts.signal.addEventListener("abort", () => ac.abort(), { once: true });
      base.abortController = ac;
    }
    const overrides = (this.opts.providerOptions ?? {}) as Partial<Options>;
    return { ...base, ...overrides };
  }

  async run(input: AgentInput, opts?: TurnOpts): Promise<TurnResult> {
    const t0 = Date.now();
    const options = this.buildOptions(opts);
    const q = this.queryFn({ prompt: input, options });

    let resultMsg: SDKResultSuccess | SDKResultError | undefined;
    let lastAssistantText = "";
    const items: AgentThreadItem[] = [];

    for await (const msg of q) {
      if (msg.session_id) this._id = msg.session_id;
      if (msg.type === "assistant") {
        const text = extractAssistantText(msg);
        if (text) lastAssistantText = text;
        items.push({ id: msg.uuid, type: "assistant", payload: msg });
      } else if (msg.type === "result") {
        resultMsg = msg;
      }
    }

    if (!resultMsg) {
      throw new Error(
        "ClaudeAgentSession: query stream ended without a result message",
      );
    }
    if (resultMsg.subtype !== "success") {
      const detail = resultMsg.errors.length > 0 ? resultMsg.errors.join("; ") : resultMsg.subtype;
      throw new Error(`ClaudeAgentSession: turn failed (${resultMsg.subtype}): ${detail}`);
    }

    const usage = mapUsage(resultMsg.usage);
    const cost = computeCost(this.opts.model, usage, this.pricingOverrides);
    const finalText =
      typeof resultMsg.result === "string" && resultMsg.result.length > 0
        ? resultMsg.result
        : lastAssistantText;

    return {
      finalText,
      items,
      usage,
      cost,
      latencyMs: Math.max(0, Date.now() - t0),
    };
  }

  async *runStreamed(
    input: AgentInput,
    opts?: TurnOpts,
  ): AsyncGenerator<AgentStreamEvent> {
    const options = this.buildOptions(opts);
    const q = this.queryFn({ prompt: input, options });
    const translator = new EventTranslator(this.opts.model, this.pricingOverrides);

    for await (const msg of q) {
      if (msg.session_id) this._id = msg.session_id;
      for (const ev of translator.translate(msg)) {
        AgentStreamEventSchema.parse(ev);
        yield ev;
      }
    }
  }
}

class EventTranslator {
  private sessionStarted = false;
  private turnStarted = false;
  private emittedToolUse = new Set<string>();

  constructor(
    private readonly model: string,
    private readonly pricingOverrides?: Readonly<Record<string, ModelPricing>>,
  ) {}

  translate(msg: SDKMessage): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = [];

    // Synthesise session-started + turn-started off the first messages we see,
    // since the Claude SDK doesn't emit dedicated "thread.started"/"turn.started"
    // events that map onto our normalised vocabulary.
    if (!this.sessionStarted && msg.session_id) {
      this.sessionStarted = true;
      out.push({
        kind: "session-started",
        sessionId: msg.session_id,
        rawProviderEvent: msg,
      });
    }
    if (!this.turnStarted && (msg.type === "assistant" || msg.type === "user")) {
      this.turnStarted = true;
      out.push({ kind: "turn-started", rawProviderEvent: msg });
    }

    switch (msg.type) {
      case "assistant":
        out.push(...this.translateAssistant(msg));
        return out;
      case "user":
        out.push(...this.translateUser(msg));
        return out;
      case "result":
        if (msg.subtype === "success") {
          const usage = mapUsage(msg.usage);
          out.push({
            kind: "turn-completed",
            usage,
            cost: computeCost(this.model, usage, this.pricingOverrides),
            rawProviderEvent: msg,
          });
        } else {
          const detail = msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype;
          out.push({
            kind: "turn-failed",
            error: { message: detail },
            rawProviderEvent: msg,
          });
        }
        return out;
      default:
        return out;
    }
  }

  private translateAssistant(msg: SDKAssistantMessage): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = [];
    const blocks = (msg.message?.content ?? []) as ReadonlyArray<unknown>;
    let textChunks = "";
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textChunks += block.text;
      } else if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : msg.uuid;
        const name = typeof block.name === "string" ? block.name : "tool";
        if (!this.emittedToolUse.has(id)) {
          out.push({
            kind: "tool-use",
            toolCallId: id,
            tool: name,
            input: block.input,
            source: classifyTool(name),
            rawProviderEvent: msg,
          });
          this.emittedToolUse.add(id);
        }
      }
    }
    if (msg.error) {
      out.push({
        kind: "warning",
        message: `assistant error: ${msg.error}`,
        rawProviderEvent: msg,
      });
    }
    if (textChunks.length > 0) {
      out.push({
        kind: "text-delta",
        messageId: msg.uuid,
        text: textChunks,
        rawProviderEvent: msg,
      });
      out.push({
        kind: "message-completed",
        messageId: msg.uuid,
        text: textChunks,
        rawProviderEvent: msg,
      });
    }
    return out;
  }

  private translateUser(msg: SDKUserMessage): AgentStreamEvent[] {
    const out: AgentStreamEvent[] = [];
    const blocks = (msg.message?.content ?? []) as ReadonlyArray<unknown>;
    if (!Array.isArray(blocks)) return out;
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!id) continue;
      const status = block.is_error === true ? "failed" : "completed";
      out.push({
        kind: "tool-result",
        toolCallId: id,
        status,
        output: block.content ?? null,
        rawProviderEvent: msg,
      });
    }
    return out;
  }
}

function extractAssistantText(msg: SDKAssistantMessage): string {
  const blocks = (msg.message?.content ?? []) as ReadonlyArray<unknown>;
  let text = "";
  for (const b of blocks) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string") {
      text += b.text;
    }
  }
  return text;
}

function mapUsage(u: NonNullableUsage): TokenUsage {
  // Claude reports `input_tokens` as the uncached portion, and reads/creates
  // separately. Our TokenUsage uses Codex's convention where `input_tokens`
  // is the grand total and `cached_input_tokens` is the cached portion of it.
  const cacheRead = numberOrZero(u.cache_read_input_tokens);
  const cacheCreation = numberOrZero(u.cache_creation_input_tokens);
  const uncachedInput = numberOrZero(u.input_tokens);
  return {
    input_tokens: uncachedInput + cacheRead + cacheCreation,
    cached_input_tokens: cacheRead,
    output_tokens: numberOrZero(u.output_tokens),
  };
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
const TODO_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
]);

function classifyTool(name: string): ToolSource {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] && parts[1].length > 0 ? parts[1] : "unknown";
    return { kind: "mcp", server };
  }
  if (SHELL_TOOLS.has(name)) return { kind: "shell" };
  if (FILE_CHANGE_TOOLS.has(name)) return { kind: "file-change" };
  if (WEB_TOOLS.has(name)) return { kind: "web-search" };
  if (TODO_TOOLS.has(name)) return { kind: "todo" };
  return { kind: "other", name };
}
