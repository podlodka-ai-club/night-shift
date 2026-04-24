import { describe, expect, it } from "vitest";
import type {
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ThreadEvent,
  Thread as CodexThread,
  Codex,
} from "@openai/codex-sdk";
import { CodexAdapter } from "./codex.js";
import type { OpenSessionOptions } from "./types.js";

function makeMockClient(opts: {
  events?: ThreadEvent[];
  finalResponse?: string;
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null;
  threadId?: string;
  startThreadSpy?: (threadOptions: unknown) => void;
}): Pick<Codex, "startThread" | "resumeThread"> {
  const threadId = opts.threadId ?? "thread-xyz";
  const thread: CodexThread = {
    get id() {
      return threadId;
    },
    async run() {
      return {
        items: [],
        finalResponse: opts.finalResponse ?? "",
        usage: opts.usage ?? { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
      };
    },
    async runStreamed() {
      const events = opts.events ?? [];
      async function* gen() {
        for (const e of events) yield e;
      }
      return { events: gen() };
    },
  } as unknown as CodexThread;

  return {
    startThread(threadOptions) {
      opts.startThreadSpy?.(threadOptions);
      return thread;
    },
    resumeThread() {
      return thread;
    },
  };
}

const baseSessionOpts: OpenSessionOptions = {
  role: "specifier",
  model: "test-model",
  runId: "r1",
  ticketId: "T-1",
  profileId: "default",
};

describe("CodexAdapter openSession defaults", () => {
  it("applies workspace-write + approvalPolicy never by default", () => {
    let captured: Record<string, unknown> | undefined;
    const client = makeMockClient({
      startThreadSpy: (o) => {
        captured = o as Record<string, unknown>;
      },
    });
    const adapter = new CodexAdapter({ codexClient: client });
    adapter.openSession(baseSessionOpts);
    expect(captured?.sandboxMode).toBe("workspace-write");
    expect(captured?.approvalPolicy).toBe("never");
    expect(captured?.model).toBe("test-model");
  });

  it("allows providerOptions to override defaults", () => {
    let captured: Record<string, unknown> | undefined;
    const client = makeMockClient({
      startThreadSpy: (o) => {
        captured = o as Record<string, unknown>;
      },
    });
    const adapter = new CodexAdapter({ codexClient: client });
    adapter.openSession({
      ...baseSessionOpts,
      providerOptions: { sandboxMode: "read-only", approvalPolicy: "on-request" },
    });
    expect(captured?.sandboxMode).toBe("read-only");
    expect(captured?.approvalPolicy).toBe("on-request");
  });

  it("rejects relative workingDirectory", () => {
    const adapter = new CodexAdapter({ codexClient: makeMockClient({}) });
    expect(() =>
      adapter.openSession({ ...baseSessionOpts, workingDirectory: "./sub" }),
    ).toThrow(/absolute/);
  });

  it("rejects openSession with missing runId", () => {
    const adapter = new CodexAdapter({ codexClient: makeMockClient({}) });
    const { runId: _r, ...bad } = baseSessionOpts;
    expect(() => adapter.openSession(bad)).toThrow();
  });
});

describe("CodexAdapter event translation (runStreamed)", () => {
  async function collect(events: ThreadEvent[], pricingOverrides?: Record<string, { inputPer1M: number; outputPer1M: number }>) {
    const client = makeMockClient({ events });
    const opts = pricingOverrides ? { codexClient: client, pricingOverrides } : { codexClient: client };
    const adapter = new CodexAdapter(opts);
    const session = adapter.openSession(baseSessionOpts);
    const out = [] as unknown[];
    for await (const ev of session.runStreamed("hi")) out.push(ev);
    return out;
  }

  it("translates thread.started to session-started", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "t1" },
    ];
    const out = await collect(events);
    expect(out).toHaveLength(1);
    expect((out[0] as { kind: string; sessionId: string }).kind).toBe("session-started");
    expect((out[0] as { sessionId: string }).sessionId).toBe("t1");
  });

  it("translates turn.started and turn.completed with cost", async () => {
    const events: ThreadEvent[] = [
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
      },
    ];
    const out = await collect(events, {
      "test-model": { inputPer1M: 1.5, outputPer1M: 0 },
    });
    expect((out[0] as { kind: string }).kind).toBe("turn-started");
    const tc = out[1] as { kind: string; cost: number; usage: { input_tokens: number } };
    expect(tc.kind).toBe("turn-completed");
    expect(tc.cost).toBe(1_500_000);
  });

  it("translates agent_message updates to text-delta then message-completed", async () => {
    const id = "m1";
    const events: ThreadEvent[] = [
      {
        type: "item.started",
        item: { id, type: "agent_message", text: "" },
      } as ItemStartedEvent,
      {
        type: "item.updated",
        item: { id, type: "agent_message", text: "Hello" },
      } as ItemUpdatedEvent,
      {
        type: "item.updated",
        item: { id, type: "agent_message", text: "Hello world" },
      } as ItemUpdatedEvent,
      {
        type: "item.completed",
        item: { id, type: "agent_message", text: "Hello world" },
      } as ItemCompletedEvent,
    ];
    const out = await collect(events);
    const kinds = out.map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(["text-delta", "text-delta", "message-completed"]);
    expect((out[0] as { text: string }).text).toBe("Hello");
    expect((out[1] as { text: string }).text).toBe(" world");
    expect((out[2] as { text: string }).text).toBe("Hello world");
  });

  it("translates command_execution to tool-use + tool-result(shell)", async () => {
    const id = "c1";
    const events: ThreadEvent[] = [
      {
        type: "item.started",
        item: {
          id,
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          status: "in_progress",
        },
      } as ItemStartedEvent,
      {
        type: "item.completed",
        item: {
          id,
          type: "command_execution",
          command: "ls",
          aggregated_output: "a\nb",
          exit_code: 0,
          status: "completed",
        },
      } as ItemCompletedEvent,
    ];
    const out = await collect(events);
    expect(out.map((e) => (e as { kind: string }).kind)).toEqual(["tool-use", "tool-result"]);
    const use = out[0] as { source: { kind: string }; toolCallId: string };
    const res = out[1] as { toolCallId: string; status: string };
    expect(use.source.kind).toBe("shell");
    expect(use.toolCallId).toBe(res.toolCallId);
    expect(res.status).toBe("completed");
  });

  it("maps item error to warning", async () => {
    const events: ThreadEvent[] = [
      {
        type: "item.completed",
        item: { id: "e1", type: "error", message: "oops" },
      } as ItemCompletedEvent,
    ];
    const out = await collect(events);
    expect((out[0] as { kind: string; message: string }).kind).toBe("warning");
    expect((out[0] as { message: string }).message).toBe("oops");
  });

  it("maps top-level error to turn-failed", async () => {
    const events: ThreadEvent[] = [{ type: "error", message: "boom" }];
    const out = await collect(events);
    expect((out[0] as { kind: string }).kind).toBe("turn-failed");
  });

  it("turn.failed becomes turn-failed", async () => {
    const events: ThreadEvent[] = [
      { type: "turn.failed", error: { message: "crashed" } },
    ];
    const out = await collect(events);
    expect((out[0] as { kind: string }).kind).toBe("turn-failed");
    expect((out[0] as { error: { message: string } }).error.message).toBe("crashed");
  });
});

describe("CodexAdapter.run", () => {
  it("returns a TurnResult with derived cost", async () => {
    const client = makeMockClient({
      finalResponse: "hello",
      usage: { input_tokens: 1_000, output_tokens: 500, cached_input_tokens: 0 },
    });
    const adapter = new CodexAdapter({
      codexClient: client,
      pricingOverrides: { "test-model": { inputPer1M: 1.0, outputPer1M: 2.0 } },
    });
    const session = adapter.openSession(baseSessionOpts);
    const result = await session.run("hi");
    expect(result.finalText).toBe("hello");
    // 1000*1.0 + 500*2.0 = 1000 + 1000 = 2000 micro-USD
    expect(result.cost).toBe(2000);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
