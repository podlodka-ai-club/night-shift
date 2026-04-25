import { describe, expect, it } from "vitest";
import { renderDashboard, type DashboardState } from "../workflow.js";

function baseDashboard(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    ticketId: "42",
    changeName: "test-change",
    currentPhase: "specify",
    blockedReason: null,
    reviewIteration: 0,
    maxIterations: 2,
    costRollup: { totalMicroUsd: 0, totalTokens: 0 },
    phases: [],
    ...overrides,
  };
}

describe("renderDashboard with startPhase", () => {
  it("shows ⏭ Specify when specify is skipped", () => {
    const output = renderDashboard(baseDashboard({
      currentPhase: "implement",
      skippedPhases: new Set(["specify"]),
    }));
    expect(output).toContain("⏭ Specify");
    expect(output).not.toContain("⏳ Specify");
  });

  it("shows ⏳ Specify by default (no skipped phases)", () => {
    const output = renderDashboard(baseDashboard({
      currentPhase: "specify",
    }));
    expect(output).toContain("⏳ Specify");
    expect(output).not.toContain("⏭ Specify");
  });

  it("shows ⏳ Implement when specify is skipped and implement is current", () => {
    const output = renderDashboard(baseDashboard({
      currentPhase: "implement",
      skippedPhases: new Set(["specify"]),
    }));
    expect(output).toContain("⏭ Specify");
    expect(output).toContain("⏳ Implement");
  });
});
