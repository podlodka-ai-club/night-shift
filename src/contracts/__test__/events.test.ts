import { describe, expect, it, vi } from "vitest";
import {
  PhaseEventSchema,
  type EventSink,
  type PhaseEvent,
} from "../events.js";

const common = {
  ticketId: "T-12",
  phase: "specify" as const,
  profileId: "default",
  ts: "2026-04-24T12:00:00.000Z",
  runId: "run-abc",
};

const tokens = { input: 100, output: 50 };

const started: PhaseEvent = {
  kind: "PhaseStarted",
  ...common,
  inputSummary: "ticket T-12",
};

const completed: PhaseEvent = {
  kind: "PhaseCompleted",
  ...common,
  outputSummary: "wrote specs",
  durationMs: 1200,
  cost: 1500,
  tokens,
};

const failed: PhaseEvent = {
  kind: "PhaseFailed",
  ...common,
  error: { name: "Error", message: "oops" },
  durationMs: 10,
};

const invoked: PhaseEvent = {
  kind: "AgentInvoked",
  ...common,
  role: "specifier",
  provider: "codex",
  model: "gpt-5.4",
  cost: 1500,
  tokens,
  latencyMs: 800,
};

const gate: PhaseEvent = {
  kind: "QualityGateEvaluated",
  ...common,
  gate: "typecheck",
  status: "passed",
  durationMs: 500,
};

describe("PhaseEventSchema", () => {
  it.each([
    ["PhaseStarted", started],
    ["PhaseCompleted", completed],
    ["PhaseFailed", failed],
    ["AgentInvoked", invoked],
    ["QualityGateEvaluated", gate],
  ] as const)("parses %s", (_kind, ev) => {
    expect(PhaseEventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects missing profileId", () => {
    const { profileId: _p, ...rest } = started as PhaseEvent & { profileId?: string };
    expect(() => PhaseEventSchema.parse(rest)).toThrow();
  });

  it("rejects Date in ts", () => {
    const bad = { ...started, ts: new Date() as unknown as string };
    expect(() => PhaseEventSchema.parse(bad)).toThrow();
  });

  it("rejects float cost", () => {
    const bad = { ...completed, cost: 0.01 };
    expect(() => PhaseEventSchema.parse(bad)).toThrow();
  });
});

describe("EventSink", () => {
  it("emit is invoked with the event", async () => {
    const emit = vi.fn();
    const sink: EventSink = { emit };
    await sink.emit(started);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(started);
  });
});
