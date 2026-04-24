import { describe, expect, it } from "vitest";
import type { EventSink, PhaseEvent } from "../../contracts/events.js";
import { InMemoryFakeAdapter, type ScriptedTurn } from "./fake.js";
import { instrumentSession } from "../instrumented.js";
import type { OpenSessionOptions } from "../types.js";

const sessionOpts: OpenSessionOptions = {
  role: "implementer",
  model: "test-model",
  runId: "r1",
  ticketId: "T-1",
  profileId: "default",
};

function makeSink() {
  const events: PhaseEvent[] = [];
  const sink: EventSink = {
    emit(e) {
      events.push(e);
    },
  };
  return { events, sink };
}

const simpleTurn = (text: string): ScriptedTurn => ({
  finalText: text,
  usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
  cost: 1234,
  events: [
    { kind: "turn-started" },
    {
      kind: "turn-completed",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
      cost: 1234,
    },
  ],
});

describe("instrumentSession", () => {
  it("emits AgentInvoked after run() succeeds", async () => {
    const { events, sink } = makeSink();
    const adapter = new InMemoryFakeAdapter({ script: [simpleTurn("x")] });
    const raw = adapter.openSession(sessionOpts);
    const instrumented = instrumentSession(raw, {
      provider: "fake",
      phase: "implement",
      sessionOptions: sessionOpts,
      sink,
    });
    await instrumented.run("hi");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("AgentInvoked");
    if (ev.kind === "AgentInvoked") {
      expect(ev.provider).toBe("fake");
      expect(ev.phase).toBe("implement");
      expect(ev.role).toBe("implementer");
      expect(ev.cost).toBe(1234);
      expect(ev.tokens).toEqual({ input: 100, output: 50 });
      expect(ev.model).toBe("test-model");
      expect(ev.ticketId).toBe("T-1");
      expect(ev.runId).toBe("r1");
      expect(ev.profileId).toBe("default");
    }
  });

  it("emits AgentInvoked when run() throws", async () => {
    const { events, sink } = makeSink();
    const adapter = new InMemoryFakeAdapter({ script: [] }); // exhausted → throws
    const raw = adapter.openSession(sessionOpts);
    const instrumented = instrumentSession(raw, {
      provider: "fake",
      phase: "specify",
      sessionOptions: sessionOpts,
      sink,
    });
    await expect(instrumented.run("hi")).rejects.toThrow();
    expect(events).toHaveLength(1);
    if (events[0]?.kind === "AgentInvoked") {
      expect(events[0].cost).toBe(0);
    }
  });

  it("emits AgentInvoked once even when stream is exited early", async () => {
    const { events, sink } = makeSink();
    const adapter = new InMemoryFakeAdapter({ script: [simpleTurn("x")] });
    const raw = adapter.openSession(sessionOpts);
    const instrumented = instrumentSession(raw, {
      provider: "fake",
      phase: "review",
      sessionOptions: sessionOpts,
      sink,
    });
    let count = 0;
    for await (const _ev of instrumented.runStreamed("hi")) {
      count++;
      if (count === 1) break; // break early before turn-completed
    }
    expect(events).toHaveLength(1);
    if (events[0]?.kind === "AgentInvoked") {
      // No turn-completed observed → cost/usage fall back to zeros
      expect(events[0].cost).toBe(0);
      expect(events[0].tokens).toEqual({ input: 0, output: 0 });
    }
  });

  it("captures cost/usage from turn-completed in the stream", async () => {
    const { events, sink } = makeSink();
    const adapter = new InMemoryFakeAdapter({ script: [simpleTurn("x")] });
    const raw = adapter.openSession(sessionOpts);
    const instrumented = instrumentSession(raw, {
      provider: "fake",
      phase: "implement",
      sessionOptions: sessionOpts,
      sink,
    });
    for await (const _ev of instrumented.runStreamed("hi")) {
      // consume all
    }
    if (events[0]?.kind === "AgentInvoked") {
      expect(events[0].cost).toBe(1234);
      expect(events[0].tokens).toEqual({ input: 100, output: 50 });
    }
  });
});
