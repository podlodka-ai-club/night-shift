import { describe, expect, it } from "vitest";
import { InMemoryFakeAdapter, type ScriptedTurn } from "./fake.js";
import type { OpenSessionOptions } from "./types.js";

const baseOpts: OpenSessionOptions = {
  role: "specifier",
  model: "gpt-5.4",
  runId: "r",
  ticketId: "T-1",
  profileId: "default",
};

const makeTurn = (finalText: string): ScriptedTurn => ({
  finalText,
  usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
  events: [
    { kind: "session-started", sessionId: "s1" },
    { kind: "turn-started" },
    { kind: "message-completed", messageId: "m1", text: finalText },
    {
      kind: "turn-completed",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
      cost: 100,
    },
  ],
});

describe("InMemoryFakeAdapter", () => {
  it("returns scripted turns in order from run()", async () => {
    const adapter = new InMemoryFakeAdapter({
      script: [makeTurn("one"), makeTurn("two")],
    });
    const session = adapter.openSession(baseOpts);
    expect((await session.run("hi")).finalText).toBe("one");
    expect((await session.run("hi")).finalText).toBe("two");
  });

  it("throws when the script is exhausted", async () => {
    const adapter = new InMemoryFakeAdapter({ script: [makeTurn("only")] });
    const session = adapter.openSession(baseOpts);
    await session.run("hi");
    await expect(session.run("hi")).rejects.toThrow(/script exhausted/);
  });

  it("runStreamed yields scripted events", async () => {
    const adapter = new InMemoryFakeAdapter({ script: [makeTurn("x")] });
    const session = adapter.openSession(baseOpts);
    const collected: string[] = [];
    for await (const ev of session.runStreamed("hi")) {
      collected.push(ev.kind);
    }
    expect(collected[0]).toBe("session-started");
    expect(collected.at(-1)).toBe("turn-completed");
  });

  it("rejects unknown role at openSession", () => {
    const adapter = new InMemoryFakeAdapter({ script: [] });
    expect(() => adapter.openSession({ ...baseOpts, role: "critic" })).toThrow();
  });

  it("rejects missing observability fields", () => {
    const adapter = new InMemoryFakeAdapter({ script: [] });
    const { profileId: _p, ...bad } = baseOpts;
    expect(() => adapter.openSession(bad)).toThrow();
  });

  it("run uses explicit cost when provided", async () => {
    const turn: ScriptedTurn = {
      ...makeTurn("x"),
      cost: 999,
    };
    const adapter = new InMemoryFakeAdapter({ script: [turn] });
    const result = await adapter.openSession(baseOpts).run("hi");
    expect(result.cost).toBe(999);
  });

  it("run derives cost from usage when not provided", async () => {
    const adapter = new InMemoryFakeAdapter({
      script: [
        {
          finalText: "x",
          usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
          events: [
            {
              kind: "turn-completed",
              usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
              cost: 0,
            },
          ],
        },
      ],
      pricingOverrides: { "gpt-5.4": { inputPer1M: 1, outputPer1M: 0 } },
    });
    const result = await adapter.openSession(baseOpts).run("hi");
    expect(result.cost).toBe(1_000_000);
  });
});
