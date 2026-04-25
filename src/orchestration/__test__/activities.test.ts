import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import {
  specifyActivity,
  implementActivity,
  reviewActivity,
  markPhaseFailureActivity,
  setActivityDepsFactory,
  type ActivityDepsFactory,
} from "../activities.js";
import { SpecifyValidationError } from "../../phases/specify/errors.js";
import { ImplementPhaseError } from "../../phases/implement/errors.js";
import { ReviewPhaseError } from "../../phases/review/errors.js";

// Mock @temporalio/activity to avoid needing a real Temporal runtime
const mockHeartbeat = vi.fn();
vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => ({
      heartbeat: mockHeartbeat,
      info: { workflowExecution: { workflowId: "ticket-1" } },
    }),
  },
}));

// ── Fake phase runners via vi.mock ────────────────────────────────────

const mockRunSpecify = vi.fn();
const mockRunImplement = vi.fn();
const mockRunReview = vi.fn();
const mockGitHub = {
  getItem: vi.fn(),
  upsertComment: vi.fn(),
  setStatus: vi.fn(),
};

vi.mock("../../phases/specify/phase.js", () => ({
  runSpecifyPhase: (...args: unknown[]) => mockRunSpecify(...args),
}));
vi.mock("../../phases/implement/phase.js", () => ({
  runImplementPhase: (...args: unknown[]) => mockRunImplement(...args),
}));
vi.mock("../../phases/review/phase.js", () => ({
  runReviewPhase: (...args: unknown[]) => mockRunReview(...args),
}));

// ── Fake deps factory ─────────────────────────────────────────────────

const fakeSpecifyDeps = { fake: "specify-deps", github: mockGitHub };
const fakeImplementDeps = { fake: "implement-deps", github: mockGitHub };
const fakeReviewDeps = { fake: "review-deps", github: mockGitHub };

const factory: ActivityDepsFactory = {
  buildSpecifyDeps: () => fakeSpecifyDeps as any,
  buildImplementDeps: () => fakeImplementDeps as any,
  buildReviewDeps: () => fakeReviewDeps as any,
};

beforeEach(() => {
  mockHeartbeat.mockReset();
  delete factory.signalProgress;
  setActivityDepsFactory(factory);
  mockRunSpecify.mockReset();
  mockRunImplement.mockReset();
  mockRunReview.mockReset();
  mockGitHub.getItem.mockReset();
  mockGitHub.upsertComment.mockReset();
  mockGitHub.setStatus.mockReset();
});

describe("specifyActivity", () => {
  it("returns SpecifyResult from phase runner", async () => {
    const result = {
      status: "refined" as const,
      bundle: { specPath: "/p", branch: "b", openQuestions: [], assumptions: [], risks: [], commitSha: "abc1234" },
      openQuestions: [],
      assumptions: [],
      risks: [],
      summary: "done",
    };
    mockRunSpecify.mockResolvedValue(result);

    const out = await specifyActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default");
    expect(out).toEqual(result);
    expect(mockRunSpecify).toHaveBeenCalledWith(fakeSpecifyDeps, { itemId: "PVTI_1", changeName: "c" });
  });
});

describe("implementActivity", () => {
  it("returns ImplementResult from phase runner", async () => {
    const result = {
      status: "pr_opened" as const,
      ticketId: "T-1",
      summary: "opened PR",
    };
    mockRunImplement.mockResolvedValue(result);

    const out = await implementActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default");
    expect(out).toEqual(result);
  });
});

describe("reviewActivity", () => {
  it("returns ReviewPhaseResult from phase runner", async () => {
    const result = {
      status: "ready_to_merge" as const,
      result: { verdict: "ready-to-merge", findings: [], iteration: 0, summary: "lgtm" },
    };
    mockRunReview.mockResolvedValue(result);

    const reviewInput = {
      ticket: { id: "1", title: "t", description: "d", status: "In review" as any, labels: [], url: "https://example.com/1", source: "github" as const, sourceRef: { kind: "github" as const, projectNodeId: "PVT_1", projectItemId: "PVTI_1", repoOwner: "o", repoName: "r", issueNumber: 1 } },
      specBundle: { specPath: "/p", branch: "b", openQuestions: [], assumptions: [], risks: [], commitSha: "abc1234" },
      pr: { number: 1, url: "https://example.com/pr/1", branch: "b", baseBranch: "main", headSha: "abc1234" },
      iteration: 0,
    };

    const out = await reviewActivity({ itemId: "PVTI_1", reviewInput }, "run-1", "default");
    expect(out).toEqual(result);
  });
});

describe("error classification", () => {
  it("wraps SpecifyPhaseError as non-retryable ApplicationFailure", async () => {
    mockRunSpecify.mockRejectedValue(new SpecifyValidationError("bad input"));

    await expect(
      specifyActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default"),
    ).rejects.toThrow(ApplicationFailure);

    try {
      await specifyActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default");
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
    }
  });

  it("lets transient errors propagate as-is", async () => {
    const transient = new Error("ECONNRESET");
    mockRunSpecify.mockRejectedValue(transient);

    await expect(
      specifyActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default"),
    ).rejects.toBe(transient);
  });

  it("wraps ImplementPhaseError validation as non-retryable", async () => {
    const err = new ImplementPhaseError("validation", "bad");
    mockRunImplement.mockRejectedValue(err);

    await expect(
      implementActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default"),
    ).rejects.toThrow(ApplicationFailure);
  });

  it("wraps ReviewPhaseError validation as non-retryable", async () => {
    const err = new ReviewPhaseError("validation", "bad");
    mockRunReview.mockRejectedValue(err);

    const reviewInput = {
      ticket: { id: "1", title: "t", description: "d", status: "In review" as any, labels: [], url: "https://example.com/1", source: "github" as const, sourceRef: { kind: "github" as const, projectNodeId: "PVT_1", projectItemId: "PVTI_1", repoOwner: "o", repoName: "r", issueNumber: 1 } },
      specBundle: { specPath: "/p", branch: "b", openQuestions: [], assumptions: [], risks: [], commitSha: "abc1234" },
      pr: { number: 1, url: "https://example.com/pr/1", branch: "b", baseBranch: "main", headSha: "abc1234" },
      iteration: 0,
    };

    await expect(
      reviewActivity({ itemId: "PVTI_1", reviewInput }, "run-1", "default"),
    ).rejects.toThrow(ApplicationFailure);
  });
});

describe("markPhaseFailureActivity", () => {
  it("blocks the item and upserts an operator comment", async () => {
    mockGitHub.getItem.mockResolvedValue({ issueNumber: 42 });
    mockGitHub.setStatus.mockResolvedValue(undefined);
    mockGitHub.upsertComment.mockResolvedValue({ commentId: 1 });

    await markPhaseFailureActivity(
      {
        itemId: "PVTI_1",
        changeName: "my-change",
        phase: "implement",
        rootCause: "quality gate runner crashed",
        nextStepStatus: "Ready",
      },
      "run-1",
      "default",
    );

    expect(mockGitHub.setStatus).toHaveBeenCalledWith("PVTI_1", "Blocked");
    expect(mockGitHub.upsertComment).toHaveBeenCalledWith(
      42,
      "workflow:phase-failure",
      expect.stringContaining("move the ticket to **Ready**"),
    );
    expect(mockGitHub.upsertComment).toHaveBeenCalledWith(
      42,
      "workflow:phase-failure",
      expect.stringContaining("quality gate runner crashed"),
    );
  });
});

describe("activity progress wiring", () => {
  it("signals activity progress when the phase emits streamed agent events", async () => {
    const signalProgress = vi.fn(async () => undefined);
    factory.signalProgress = signalProgress;
    setActivityDepsFactory(factory);

    mockRunSpecify.mockImplementation(async (deps) => {
      await deps.onAgentEvent?.({
        kind: "tool-use",
        toolCallId: "tool-1",
        tool: "npm test",
        input: {},
        source: { kind: "shell" },
      });
      return {
        status: "refined",
        bundle: { specPath: "/p", branch: "b", openQuestions: [], assumptions: [], risks: [], commitSha: "abc1234" },
        openQuestions: [],
        assumptions: [],
        risks: [],
        summary: "done",
      };
    });

    await specifyActivity({ itemId: "PVTI_1", changeName: "c" }, "run-1", "default");

    expect(signalProgress).toHaveBeenCalledWith(
      "ticket-1",
      expect.stringContaining("### 🤖 Specify — running"),
    );
    expect(signalProgress).toHaveBeenCalledWith(
      "ticket-1",
      expect.stringContaining("⚡ shell `npm test`"),
    );
  });
});
