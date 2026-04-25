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

  it("accepts phase: review", () => {
    const ev = { ...started, phase: "review" as const };
    expect(PhaseEventSchema.parse(ev)).toEqual(ev);
  });

  it("parses WorkflowStarted", () => {
    const ev = {
      kind: "WorkflowStarted" as const,
      ticketId: "T-12",
      ts: "2026-04-24T12:00:00.000Z",
      runId: "run-abc",
    };
    expect(PhaseEventSchema.parse(ev)).toEqual(ev);
  });

  it("parses WorkflowFinished with costRollup", () => {
    const ev = {
      kind: "WorkflowFinished" as const,
      ticketId: "T-12",
      ts: "2026-04-24T12:05:00.000Z",
      runId: "run-abc",
      status: "completed" as const,
      latencyMs: 300_000,
      costRollup: { totalMicroUsd: 5000, totalTokens: 2000 },
    };
    const parsed = PhaseEventSchema.parse(ev);
    expect(parsed).toEqual(ev);
    expect(parsed.kind).toBe("WorkflowFinished");
  });

  it("discriminator narrows WorkflowFinished status to escalated", () => {
    const ev = {
      kind: "WorkflowFinished" as const,
      ticketId: "T-12",
      ts: "2026-04-24T12:05:00.000Z",
      runId: "run-abc",
      status: "escalated" as const,
      latencyMs: 7_200_000,
      costRollup: { totalMicroUsd: 10_000, totalTokens: 5_000 },
    };
    expect(PhaseEventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects WorkflowFinished with invalid status", () => {
    const ev = {
      kind: "WorkflowFinished" as const,
      ticketId: "T-12",
      ts: "2026-04-24T12:05:00.000Z",
      runId: "run-abc",
      status: "unknown",
      latencyMs: 0,
      costRollup: { totalMicroUsd: 0, totalTokens: 0 },
    };
    expect(() => PhaseEventSchema.parse(ev)).toThrow();
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
