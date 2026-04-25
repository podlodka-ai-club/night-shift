import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock @temporalio/workflow ─────────────────────────────────────────
// We simulate the Temporal workflow sandbox by providing mock implementations
// of proxyActivities, signals, queries, condition, and workflowInfo.

type ConditionFn = () => boolean;
let pendingConditions: Array<{ fn: ConditionFn; resolve: () => void }> = [];
const signalHandlers = new Map<string, () => void>();
const queryHandlers = new Map<string, () => unknown>();

function resolveConditions() {
  for (const entry of [...pendingConditions]) {
    if (entry.fn()) {
      entry.resolve();
      pendingConditions = pendingConditions.filter((e) => e !== entry);
    }
  }
}

function fireSignal(name: string) {
  const handler = signalHandlers.get(name);
  if (handler) handler();
  // After signal, check if any conditions are now satisfied
  resolveConditions();
}

function queryValue(name: string): unknown {
  const handler = queryHandlers.get(name);
  return handler ? handler() : undefined;
}

const mockSpecify = vi.fn();
const mockImplement = vi.fn();
const mockReview = vi.fn();
const mockSetCurrentDetails = vi.fn();

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    specifyActivity: (...args: unknown[]) => mockSpecify(...args),
    implementActivity: (...args: unknown[]) => mockImplement(...args),
    reviewActivity: (...args: unknown[]) => mockReview(...args),
  }),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (nameOrSignal: string, handler: () => unknown) => {
    // Check if it's a signal or query by whether the test registered it
    if (["specifyRetry", "specReviewed", "implementRetry", "resume"].includes(nameOrSignal)) {
      signalHandlers.set(nameOrSignal, handler as () => void);
    } else if (nameOrSignal === "getBlockedReason") {
      queryHandlers.set(nameOrSignal, handler);
    }
  },
  condition: (fn: ConditionFn) => {
    if (fn()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pendingConditions.push({ fn, resolve });
    });
  },
  workflowInfo: () => ({ workflowId: "ticket-T-42" }),
  setCurrentDetails: (...args: unknown[]) => mockSetCurrentDetails(...args),
}));

// Import after mocks are set up
const { ticketWorkflow } = await import("../workflow.js");
const { renderDashboard, formatDuration } = await import("../workflow.js");

const BASE_INPUT = {
  itemId: "PVTI_1",
  ticketId: "T-42",
  changeName: "my-change",
  maxReviewIterations: 2,
};

beforeEach(() => {
  mockSpecify.mockReset();
  mockImplement.mockReset();
  mockReview.mockReset();
  mockSetCurrentDetails.mockReset();
  pendingConditions = [];
  signalHandlers.clear();
  queryHandlers.clear();
});

describe("ticketWorkflow", () => {
  it("happy path: specify → specReviewed → implement → review → completed", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);

    // Let specify resolve, then workflow waits at specReviewed gate
    await flushMicrotasks();
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    // Send specReviewed signal
    fireSignal("specReviewed");
    await wfPromise;

    expect(mockSpecify).toHaveBeenCalledOnce();
    expect(mockImplement).toHaveBeenCalledOnce();
    expect(mockReview).toHaveBeenCalledOnce();
  });

  it("specify needs_input → blocks → specifyRetry → re-runs specify", async () => {
    mockSpecify
      .mockResolvedValueOnce({ status: "needs_input" })
      .mockResolvedValueOnce({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("specify_needs_input");

    fireSignal("specifyRetry");
    await flushMicrotasks();

    // Now at awaiting_spec_review after second specify run
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");
    expect(mockSpecify).toHaveBeenCalledTimes(2);

    fireSignal("specReviewed");
    await wfPromise;
  });

  it("specify refined → specifyRetry (operator rejects) → re-runs specify", async () => {
    mockSpecify
      .mockResolvedValueOnce({ status: "refined" })
      .mockResolvedValueOnce({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    // Operator rejects spec, sends specifyRetry
    fireSignal("specifyRetry");
    await flushMicrotasks();

    // Re-runs specify, refined again, waits
    expect(mockSpecify).toHaveBeenCalledTimes(2);
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    fireSignal("specReviewed");
    await wfPromise;
  });

  it("implement needs_input → blocks → implementRetry → re-runs implement", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement
      .mockResolvedValueOnce({ status: "needs_input", ticketId: "T-42", summary: "blocked" })
      .mockResolvedValueOnce({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    fireSignal("specReviewed");
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("implement_needs_input");

    fireSignal("implementRetry");
    await wfPromise;

    expect(mockImplement).toHaveBeenCalledTimes(2);
  });

  it("review needs_fix loops implement + review, max iterations escalates", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "needs_fix", result: { verdict: "needs-fix", findings: [], iteration: 0, summary: "fix it" } });

    const wfPromise = ticketWorkflow({ ...BASE_INPUT, maxReviewIterations: 2 });
    await flushMicrotasks();

    fireSignal("specReviewed");
    await flushMicrotasks();

    // After maxIterations of needs_fix, should enter escalation
    expect(queryValue("getBlockedReason")).toBe("review_escalation");

    // Resume from escalation → review loops again, still needs_fix → escalate again
    fireSignal("resume");
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("review_escalation");

    // Let it succeed this time
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });
    fireSignal("resume");
    await wfPromise;
  });

  it("review escalate → blocks → resume → re-enters review at iteration 0", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview
      .mockResolvedValueOnce({ status: "escalated", result: { verdict: "escalate", findings: [], iteration: 0, summary: "too complex" } })
      .mockResolvedValueOnce({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    fireSignal("specReviewed");
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("review_escalation");

    fireSignal("resume");
    await wfPromise;

    // Review was called twice (once escalated, once after resume)
    expect(mockReview).toHaveBeenCalledTimes(2);
  });

  it("getBlockedReason returns null when no gate is active", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    // Before signal, should be awaiting_spec_review
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    fireSignal("specReviewed");
    await wfPromise;

    // After completion, should be null
    expect(queryValue("getBlockedReason")).toBeNull();
  });

  it("stale signal does not unblock unrelated gate", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement
      .mockResolvedValueOnce({ status: "needs_input", ticketId: "T-42", summary: "blocked" })
      .mockResolvedValueOnce({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    // At specReviewed gate, send implementRetry (stale signal for wrong gate)
    fireSignal("implementRetry");
    await flushMicrotasks();

    // Should still be at specReviewed gate
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    // Now send correct signal
    fireSignal("specReviewed");
    await flushMicrotasks();

    // Should now be at implement gate (needs_input)
    expect(queryValue("getBlockedReason")).toBe("implement_needs_input");

    // The stale implementRetry should NOT unblock this gate
    // (because the flag was reset on gate entry)
    // Need to send a fresh implementRetry
    fireSignal("implementRetry");
    await wfPromise;
  });

  it("rapid duplicate signals are idempotent", async () => {
    mockSpecify
      .mockResolvedValueOnce({ status: "needs_input" })
      .mockResolvedValueOnce({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    expect(queryValue("getBlockedReason")).toBe("specify_needs_input");

    // Send specifyRetry twice rapidly
    fireSignal("specifyRetry");
    fireSignal("specifyRetry");
    await flushMicrotasks();

    // Specify should be re-run exactly once (now at awaiting_spec_review)
    expect(mockSpecify).toHaveBeenCalledTimes(2);
    expect(queryValue("getBlockedReason")).toBe("awaiting_spec_review");

    fireSignal("specReviewed");
    await wfPromise;
  });
});

describe("renderDashboard", () => {
  const baseDashState = {
    ticketId: "T-42",
    changeName: "my-change",
    currentPhase: "specify" as const,
    blockedReason: null as any,
    reviewIteration: 0,
    maxIterations: 2,
    costRollup: { totalMicroUsd: 0, totalTokens: 0 },
    phases: [],
  };

  it("includes ticket ID, change name, current phase, and running status", () => {
    const md = renderDashboard(baseDashState);
    expect(md).toContain("T-42");
    expect(md).toContain("my-change");
    expect(md).toContain("Specify");
    expect(md).toContain("Running");
  });

  it("shows blocked reason in status line", () => {
    const md = renderDashboard({ ...baseDashState, blockedReason: "awaiting_spec_review" });
    expect(md).toContain("Blocked");
    expect(md).toContain("awaiting_spec_review");
  });

  it("shows timeline table with durations for completed phases", () => {
    const md = renderDashboard({
      ...baseDashState,
      currentPhase: "implement",
      phases: [{ name: "specify", startedAt: 1000, finishedAt: 135000, result: "refined" }],
    });
    expect(md).toContain("Timeline");
    expect(md).toContain("Specify");
    expect(md).toContain("2m 14s");
    expect(md).toContain("refined");
  });

  it("shows review iteration during review phase", () => {
    const md = renderDashboard({
      ...baseDashState,
      currentPhase: "review",
      reviewIteration: 1,
      maxIterations: 2,
    });
    expect(md).toContain("iteration 1/2");
  });

  it("shows cost rollup", () => {
    const md = renderDashboard({
      ...baseDashState,
      costRollup: { totalMicroUsd: 1_500_000, totalTokens: 10000 },
    });
    expect(md).toContain("$1.50");
    expect(md).toContain("10000 tokens");
  });

  it("shows completed status when phase is done", () => {
    const md = renderDashboard({ ...baseDashState, currentPhase: "done" });
    expect(md).toContain("Completed");
  });

  it("rendered output is under 2048 bytes for full 3-phase workflow with 2 review iterations", () => {
    const md = renderDashboard({
      ...baseDashState,
      currentPhase: "done",
      costRollup: { totalMicroUsd: 5_000_000, totalTokens: 99999 },
      phases: [
        { name: "specify", startedAt: 0, finishedAt: 120000, result: "refined" },
        { name: "implement", startedAt: 120000, finishedAt: 300000, result: "pr_opened" },
        { name: "review", startedAt: 300000, finishedAt: 360000, result: "needs_fix", iteration: 0 },
        { name: "implement", startedAt: 360000, finishedAt: 480000, result: "fix", iteration: 1 },
        { name: "review", startedAt: 480000, finishedAt: 540000, result: "ready_to_merge", iteration: 1 },
      ],
    });
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThan(2048);
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("ticketWorkflow dashboard integration", () => {
  it("calls setCurrentDetails at workflow start, after phases, and at completion", async () => {
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    // At this point: initial + after specify + awaiting_spec_review = at least 3 calls
    expect(mockSetCurrentDetails.mock.calls.length).toBeGreaterThanOrEqual(3);

    // First call should contain ticket ID
    expect(mockSetCurrentDetails.mock.calls[0]![0]).toContain("T-42");

    // Blocked gate should show in a recent call
    const lastCallBeforeSignal = mockSetCurrentDetails.mock.calls.at(-1)![0];
    expect(lastCallBeforeSignal).toContain("awaiting_spec_review");

    fireSignal("specReviewed");
    await wfPromise;

    // Final call should show "Completed"
    const finalCall = mockSetCurrentDetails.mock.calls.at(-1)![0];
    expect(finalCall).toContain("Completed");
  });

  it("updates dashboard on blocked gate entry", async () => {
    mockSpecify.mockResolvedValue({ status: "needs_input" });

    const wfPromise = ticketWorkflow(BASE_INPUT);
    await flushMicrotasks();

    // Find a call containing the blocked reason
    const calls = mockSetCurrentDetails.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c) => c.includes("specify_needs_input"))).toBe(true);

    // Clean up
    mockSpecify.mockResolvedValue({ status: "refined" });
    mockImplement.mockResolvedValue({ status: "pr_opened", ticketId: "T-42", summary: "done" });
    mockReview.mockResolvedValue({ status: "ready_to_merge", result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" } });
    fireSignal("specifyRetry");
    await flushMicrotasks();
    fireSignal("specReviewed");
    await wfPromise;
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
