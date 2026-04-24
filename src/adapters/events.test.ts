import { describe, expect, it } from "vitest";
import {
  AgentStreamEventSchema,
  ToolSourceSchema,
  TurnResultSchema,
  type AgentStreamEvent,
} from "./events.js";
import { AgentRoleSchema, OpenSessionOptionsSchema } from "./types.js";

describe("AgentRoleSchema", () => {
  it.each(["specifier", "implementer", "reviewer", "subagent"] as const)(
    "accepts %s",
    (r) => {
      expect(AgentRoleSchema.parse(r)).toBe(r);
    },
  );

  it("rejects unknown roles", () => {
    expect(() => AgentRoleSchema.parse("critic")).toThrow();
  });
});

describe("OpenSessionOptionsSchema", () => {
  const base = {
    role: "specifier",
    model: "m",
    runId: "r",
    ticketId: "t",
    profileId: "p",
  };
  it("parses a valid payload", () => {
    expect(() => OpenSessionOptionsSchema.parse(base)).not.toThrow();
  });
  it.each(["runId", "ticketId", "profileId"] as const)("requires %s", (k) => {
    const bad = { ...base };
    delete (bad as Record<string, unknown>)[k];
    expect(() => OpenSessionOptionsSchema.parse(bad)).toThrow();
  });
});

describe("ToolSourceSchema", () => {
  it.each([
    { kind: "shell" },
    { kind: "file-change" },
    { kind: "web-search" },
    { kind: "mcp", server: "nightwatch" },
    { kind: "todo" },
    { kind: "other", name: "custom" },
  ])("accepts source $kind", (s) => {
    expect(() => ToolSourceSchema.parse(s)).not.toThrow();
  });
  it("rejects mcp without server", () => {
    expect(() => ToolSourceSchema.parse({ kind: "mcp" })).toThrow();
  });
});

describe("AgentStreamEventSchema", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 };
  const examples: AgentStreamEvent[] = [
    { kind: "session-started", sessionId: "s" },
    { kind: "turn-started" },
    { kind: "text-delta", messageId: "m1", text: "hi" },
    { kind: "message-completed", messageId: "m1", text: "hello" },
    { kind: "reasoning", text: "..." },
    {
      kind: "tool-use",
      toolCallId: "c1",
      tool: "bash",
      input: { cmd: "ls" },
      source: { kind: "shell" },
    },
    { kind: "tool-result", toolCallId: "c1", status: "completed", output: "ok" },
    { kind: "turn-completed", usage, cost: 0 },
    { kind: "turn-failed", error: { message: "boom" } },
    { kind: "warning", message: "weird" },
  ];
  it.each(examples)("parses variant %#", (ev) => {
    expect(() => AgentStreamEventSchema.parse(ev)).not.toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      AgentStreamEventSchema.parse({ kind: "mystery" } as unknown),
    ).toThrow();
  });

  it("tool-use and tool-result can share toolCallId", () => {
    const use = AgentStreamEventSchema.parse(examples[5]);
    const res = AgentStreamEventSchema.parse(examples[6]);
    if (use.kind === "tool-use" && res.kind === "tool-result") {
      expect(use.toolCallId).toBe(res.toolCallId);
    } else {
      throw new Error("unexpected narrowing failure");
    }
  });
});

describe("TurnResultSchema", () => {
  it("parses a valid result", () => {
    const r = {
      finalText: "x",
      items: [],
      usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
      cost: 42,
      latencyMs: 100,
    };
    expect(TurnResultSchema.parse(r)).toEqual(r);
  });
});
