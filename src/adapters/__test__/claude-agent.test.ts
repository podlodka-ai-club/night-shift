import { describe, expect, it } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentAdapter, type ClaudeQueryFn } from "../claude-agent.js";
import type { OpenSessionOptions } from "../types.js";

function makeQueryFn(
  messages: SDKMessage[],
  spy?: (params: { prompt: unknown; options?: Options }) => void,
): ClaudeQueryFn {
  return ((params) => {
    spy?.(params as { prompt: unknown; options?: Options });
    async function* gen() {
      for (const m of messages) yield m;
    }
    const iter = gen();
    return iter as unknown as Query;
  }) as ClaudeQueryFn;
}

const baseSessionOpts: OpenSessionOptions = {
  role: "specifier",
  model: "claude-sonnet-4-6",
  runId: "r1",
  ticketId: "T-1",
  profileId: "default",
};

const successUsage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const;

function successResult(text = "ok"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: successUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: "u-result",
    session_id: "s-1",
  } as unknown as SDKMessage;
}

function assistantText(text: string, uuid = "u-asst"): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid,
    session_id: "s-1",
    message: {
      content: [{ type: "text", text }],
    },
  } as unknown as SDKMessage;
}

function assistantToolUse(
  id: string,
  name: string,
  input: unknown,
  uuid = "u-asst",
): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid,
    session_id: "s-1",
    message: {
      content: [{ type: "tool_use", id, name, input }],
    },
  } as unknown as SDKMessage;
}

function userToolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    uuid: "u-user",
    session_id: "s-1",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  } as unknown as SDKMessage;
}

describe("ClaudeAgentAdapter openSession", () => {
  it("sets workspace-write defaults via permissionMode + bypass", async () => {
    let captured: Options | undefined;
    const queryFn = makeQueryFn([assistantText("hi"), successResult()], (p) => {
      captured = p.options;
    });
    const a = new ClaudeAgentAdapter({ queryFn });
    expect(a.provider).toBe("claude-agent");
    const s = a.openSession(baseSessionOpts);
    await s.run("hello");
    expect(captured?.permissionMode).toBe("bypassPermissions");
    expect(captured?.allowDangerouslySkipPermissions).toBe(true);
    expect(captured?.model).toBe("claude-sonnet-4-6");
  });

  it("allows providerOptions to override defaults", async () => {
    let captured: Options | undefined;
    const queryFn = makeQueryFn([successResult()], (p) => {
      captured = p.options;
    });
    const a = new ClaudeAgentAdapter({ queryFn });
    const s = a.openSession({
      ...baseSessionOpts,
      providerOptions: { permissionMode: "acceptEdits", maxTurns: 3 },
    });
    await s.run("hi");
    expect(captured?.permissionMode).toBe("acceptEdits");
    expect(captured?.maxTurns).toBe(3);
  });

  it("rejects relative workingDirectory", () => {
    const a = new ClaudeAgentAdapter({ queryFn: makeQueryFn([]) });
    expect(() =>
      a.openSession({ ...baseSessionOpts, workingDirectory: "./sub" }),
    ).toThrow(/absolute/);
  });

  it("rejects openSession with missing runId", () => {
    const a = new ClaudeAgentAdapter({ queryFn: makeQueryFn([]) });
    const { runId: _r, ...bad } = baseSessionOpts;
    expect(() => a.openSession(bad)).toThrow();
  });

  it("forwards outputSchema as json_schema outputFormat", async () => {
    let captured: Options | undefined;
    const queryFn = makeQueryFn([successResult()], (p) => {
      captured = p.options;
    });
    const a = new ClaudeAgentAdapter({ queryFn });
    const s = a.openSession(baseSessionOpts);
    const schema = { type: "object", properties: { foo: { type: "string" } } };
    await s.run("hi", { outputSchema: schema });
    expect(captured?.outputFormat).toEqual({ type: "json_schema", schema });
  });
});

describe("ClaudeAgentAdapter.run", () => {
  it("returns finalText from result.result with derived cost", async () => {
    const messages = [assistantText("ignored"), successResult("the answer")];
    const a = new ClaudeAgentAdapter({
      queryFn: makeQueryFn(messages),
      pricingOverrides: {
        "claude-sonnet-4-6": { inputPer1M: 2.0, outputPer1M: 4.0 },
      },
    });
    const s = a.openSession(baseSessionOpts);
    const r = await s.run("hi");
    expect(r.finalText).toBe("the answer");
    // 1000*2 + 500*4 = 4000 micro-USD
    expect(r.cost).toBe(4000);
    expect(r.usage.input_tokens).toBe(1000);
    expect(r.usage.output_tokens).toBe(500);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to last assistant text when result.result is empty", async () => {
    const empty = successResult("");
    const a = new ClaudeAgentAdapter({ queryFn: makeQueryFn([assistantText("salut"), empty]) });
    const s = a.openSession(baseSessionOpts);
    const r = await s.run("bonjour");
    expect(r.finalText).toBe("salut");
  });

  it("throws when query stream has no result message", async () => {
    const a = new ClaudeAgentAdapter({ queryFn: makeQueryFn([assistantText("orphan")]) });
    const s = a.openSession(baseSessionOpts);
    await expect(s.run("x")).rejects.toThrow(/without a result message/);
  });

  it("throws on result error subtype", async () => {
    const errMsg = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 99,
      stop_reason: null,
      total_cost_usd: 0,
      usage: successUsage,
      modelUsage: {},
      permission_denials: [],
      errors: ["hit cap"],
      uuid: "u",
      session_id: "s-1",
    } as unknown as SDKMessage;
    const a = new ClaudeAgentAdapter({ queryFn: makeQueryFn([errMsg]) });
    const s = a.openSession(baseSessionOpts);
    await expect(s.run("x")).rejects.toThrow(/error_max_turns.*hit cap/);
  });

  it("captures session_id for resume on subsequent calls", async () => {
    let captured: Options | undefined;
    const queryFn: ClaudeQueryFn = ((params) => {
      captured = (params as { options?: Options }).options;
      async function* gen() {
        yield successResult();
      }
      return gen() as unknown as Query;
    }) as ClaudeQueryFn;
    const a = new ClaudeAgentAdapter({ queryFn });
    const s = a.openSession(baseSessionOpts);
    await s.run("first");
    expect(captured?.resume).toBeUndefined();
    await s.run("second");
    expect(captured?.resume).toBe("s-1");
    expect(s.id).toBe("s-1");
  });
});

describe("ClaudeAgentAdapter.runStreamed event translation", () => {
  async function collect(messages: SDKMessage[], pricingOverrides?: Record<string, { inputPer1M: number; outputPer1M: number }>) {
    const a = new ClaudeAgentAdapter({
      queryFn: makeQueryFn(messages),
      ...(pricingOverrides ? { pricingOverrides } : {}),
    });
    const s = a.openSession(baseSessionOpts);
    const out: unknown[] = [];
    for await (const ev of s.runStreamed("hi")) out.push(ev);
    return out;
  }

  it("emits session-started, turn-started, text-delta, message-completed, turn-completed", async () => {
    const out = await collect(
      [assistantText("hello"), successResult()],
      { "claude-sonnet-4-6": { inputPer1M: 1.0, outputPer1M: 2.0 } },
    );
    const kinds = out.map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual([
      "session-started",
      "turn-started",
      "text-delta",
      "message-completed",
      "turn-completed",
    ]);
    const tc = out[4] as { cost: number; usage: { input_tokens: number } };
    expect(tc.cost).toBe(1000 * 1.0 + 500 * 2.0); // 2000 micro-USD
    expect(tc.usage.input_tokens).toBe(1000);
  });

  it("translates tool_use blocks with classification", async () => {
    const out = await collect([
      assistantToolUse("call-1", "Bash", { command: "ls" }),
      userToolResult("call-1", "a\nb"),
      successResult(),
    ]);
    const events = out.map((e) => e as { kind: string; tool?: string; source?: { kind: string }; status?: string });
    const toolUse = events.find((e) => e.kind === "tool-use");
    const toolResult = events.find((e) => e.kind === "tool-result");
    expect(toolUse?.tool).toBe("Bash");
    expect(toolUse?.source?.kind).toBe("shell");
    expect(toolResult?.status).toBe("completed");
  });

  it("classifies file-change tools", async () => {
    const out = await collect([
      assistantToolUse("c", "Edit", { path: "x" }),
      successResult(),
    ]);
    const tu = out.find((e) => (e as { kind: string }).kind === "tool-use") as { source: { kind: string } };
    expect(tu.source.kind).toBe("file-change");
  });

  it("classifies mcp tools and extracts server", async () => {
    const out = await collect([
      assistantToolUse("c", "mcp__github__create_issue", {}),
      successResult(),
    ]);
    const tu = out.find((e) => (e as { kind: string }).kind === "tool-use") as { source: { kind: string; server?: string } };
    expect(tu.source.kind).toBe("mcp");
    expect(tu.source.server).toBe("github");
  });

  it("maps tool_result with is_error=true to failed", async () => {
    const out = await collect([
      assistantToolUse("c", "Bash", { command: "x" }),
      userToolResult("c", "boom", true),
      successResult(),
    ]);
    const tr = out.find((e) => (e as { kind: string }).kind === "tool-result") as { status: string };
    expect(tr.status).toBe("failed");
  });

  it("emits turn-failed for result error subtype", async () => {
    const errMsg = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: successUsage,
      modelUsage: {},
      permission_denials: [],
      errors: ["boom"],
      uuid: "u",
      session_id: "s-1",
    } as unknown as SDKMessage;
    const out = await collect([errMsg]);
    const tf = out.find((e) => (e as { kind: string }).kind === "turn-failed") as { error: { message: string } };
    expect(tf.error.message).toBe("boom");
  });
});

describe("ClaudeAgentAdapter usage mapping", () => {
  it("rolls cache_read + cache_creation into total input_tokens", async () => {
    const result = {
      type: "result",
      subtype: "success",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: "x",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "u",
      session_id: "s-1",
    } as unknown as SDKMessage;
    const a = new ClaudeAgentAdapter({
      queryFn: makeQueryFn([result]),
      pricingOverrides: {
        "claude-sonnet-4-6": {
          inputPer1M: 1.0,
          outputPer1M: 2.0,
          cachedInputPer1M: 0.1,
        },
      },
    });
    const s = a.openSession(baseSessionOpts);
    const r = await s.run("hi");
    // Total input_tokens = 100 + 200 + 30 = 330
    expect(r.usage.input_tokens).toBe(330);
    expect(r.usage.cached_input_tokens).toBe(200);
    expect(r.usage.output_tokens).toBe(50);
    // Uncached input = 130, priced at 1.0/1M => 130 micro
    // Cached = 200, priced at 0.1/1M => 20 micro
    // Output = 50, priced at 2.0/1M => 100 micro
    // Total = 250 micro-USD
    expect(r.cost).toBe(250);
  });
});
