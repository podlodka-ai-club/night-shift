import { describe, expect, it, beforeEach, vi } from "vitest";
import { createInMemoryFakeGitHubClient } from "../../github/__test__/fake.js";
import type { FakeGitHubClient } from "../../github/__test__/fake.js";

const mockStart = vi.fn();
const mockQuery = vi.fn();
const mockSignal = vi.fn();

vi.mock("@temporalio/client", () => {
  class WorkflowExecutionAlreadyStartedError extends Error {
    override name = "WorkflowExecutionAlreadyStartedError";
  }
  return {
    Connection: {
      connect: vi.fn().mockResolvedValue({}),
    },
    Client: vi.fn().mockImplementation(() => ({
      workflow: {
        start: (...args: unknown[]) => mockStart(...args),
        getHandle: () => ({
          query: (...args: unknown[]) => mockQuery(...args),
          signal: (...args: unknown[]) => mockSignal(...args),
        }),
      },
    })),
    WorkflowExecutionAlreadyStartedError,
  };
});

import {
  setPickupGitHubClient,
  setPickupTemporalConfig,
  scanBoardActivity,
  startTicketWorkflowsActivity,
} from "../pickup-activities.js";

let gh: FakeGitHubClient;

beforeEach(() => {
  gh = createInMemoryFakeGitHubClient();
  setPickupGitHubClient(gh);
  setPickupTemporalConfig("localhost:7233", "default");
  mockStart.mockReset().mockResolvedValue({ workflowId: "ticket-1" });
  mockQuery.mockReset().mockResolvedValue(null);
  mockSignal.mockReset().mockResolvedValue(undefined);
});

describe("scanBoardActivity", () => {
  it("discovers Backlog items with startPhase specify", async () => {
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, title: "Fix login", status: "Backlog", createdAt: "2026-01-01T00:00:00Z" });

    const result = await scanBoardActivity();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      itemId: "PVTI_1",
      ticketId: "1",
      changeName: "fix-login-1",
      startPhase: "specify",
    });
  });

  it("discovers Ready items with startPhase implement", async () => {
    gh.seedItem({ itemId: "PVTI_2", issueNumber: 2, title: "Add tests", status: "Ready", createdAt: "2026-01-01T00:00:00Z" });

    const result = await scanBoardActivity();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      startPhase: "implement",
      changeName: "add-tests-2",
    });
  });

  it("merges and sorts Backlog + Ready by createdAt", async () => {
    gh.seedItem({ itemId: "PVTI_B", issueNumber: 2, title: "B", status: "Backlog", createdAt: "2026-03-01T00:00:00Z" });
    gh.seedItem({ itemId: "PVTI_R", issueNumber: 1, title: "R", status: "Ready", createdAt: "2026-01-01T00:00:00Z" });
    gh.seedItem({ itemId: "PVTI_A", issueNumber: 3, title: "A", status: "Backlog", createdAt: "2026-02-01T00:00:00Z" });

    const result = await scanBoardActivity();
    expect(result.items.map((i) => i.itemId)).toEqual(["PVTI_R", "PVTI_A", "PVTI_B"]);
    expect(result.items[0]!.startPhase).toBe("implement");
    expect(result.items[1]!.startPhase).toBe("specify");
  });

  it("returns empty items when board has no Backlog or Ready", async () => {
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "In progress" });

    const result = await scanBoardActivity();
    expect(result.items).toEqual([]);
  });

  it("produces the same ticketId pattern as the webhook bridge", async () => {
    gh.seedItem({ itemId: "PVTI_1", issueNumber: 42, title: "Foo", status: "Backlog", createdAt: "2026-01-01T00:00:00Z" });

    const result = await scanBoardActivity();
    // webhook bridge uses `ticket-${event.ticketId}` where ticketId comes from getItem()
    // getItem() returns ticketId = String(issueNumber)
    const workflowId = `ticket-${result.items[0]!.ticketId}`;
    expect(workflowId).toBe("ticket-42");
  });
});

describe("startTicketWorkflowsActivity", () => {
  it("signals specifyRetry for blocked backlog workflows instead of skipping them", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-1", "ticketWorkflow"));
    mockQuery.mockResolvedValue("awaiting_spec_review");

    const result = await startTicketWorkflowsActivity({
      items: [
        {
          itemId: "PVTI_1",
          ticketId: "1",
          issueNumber: 1,
          title: "Fix login",
          changeName: "fix-login-1",
          startPhase: "specify",
        },
      ],
      maxStarts: 1,
      taskQueue: "night-shift",
    });

    expect(result).toEqual({ started: 0, signaled: 1, skipped: 0 });
    expect(mockSignal).toHaveBeenCalledWith("specifyRetry");
  });

  it("counts signaled workflows against the per-tick cap", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart
      .mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError("dup", "ticket-1", "ticketWorkflow"))
      .mockResolvedValue({ workflowId: "ticket-2" });
    mockQuery.mockResolvedValue("awaiting_spec_review");

    const result = await startTicketWorkflowsActivity({
      items: [
        {
          itemId: "PVTI_1",
          ticketId: "1",
          issueNumber: 1,
          title: "Fix login",
          changeName: "fix-login-1",
          startPhase: "specify",
        },
        {
          itemId: "PVTI_2",
          ticketId: "2",
          issueNumber: 2,
          title: "Add tests",
          changeName: "add-tests-2",
          startPhase: "specify",
        },
      ],
      maxStarts: 1,
      taskQueue: "night-shift",
    });

    expect(result).toEqual({ started: 0, signaled: 1, skipped: 0 });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
