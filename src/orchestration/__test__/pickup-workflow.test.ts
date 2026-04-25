import { beforeEach, describe, expect, it, vi } from "vitest";

const mockScanBoard = vi.fn();
const mockStartTicketWorkflows = vi.fn();

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    scanBoardActivity: (...args: unknown[]) => mockScanBoard(...args),
    startTicketWorkflowsActivity: (...args: unknown[]) => mockStartTicketWorkflows(...args),
  }),
  workflowInfo: () => ({ taskQueue: "pickup-queue" }),
}));

const { pickupWorkflow } = await import("../pickup-workflow.js");

beforeEach(() => {
  mockScanBoard.mockReset();
  mockStartTicketWorkflows.mockReset();
});

describe("pickupWorkflow", () => {
  it("passes all scanned items and caps actual starts in the activity", async () => {
    mockScanBoard.mockResolvedValue({
      items: [
        { itemId: "PVTI_1", ticketId: "1", issueNumber: 1, title: "One", changeName: "one-1", startPhase: "specify" },
        { itemId: "PVTI_2", ticketId: "2", issueNumber: 2, title: "Two", changeName: "two-2", startPhase: "implement" },
        { itemId: "PVTI_3", ticketId: "3", issueNumber: 3, title: "Three", changeName: "three-3", startPhase: "specify" },
      ],
    });

    await pickupWorkflow(2);

    expect(mockStartTicketWorkflows).toHaveBeenCalledWith({
      items: [
        { itemId: "PVTI_1", ticketId: "1", issueNumber: 1, title: "One", changeName: "one-1", startPhase: "specify" },
        { itemId: "PVTI_2", ticketId: "2", issueNumber: 2, title: "Two", changeName: "two-2", startPhase: "implement" },
        { itemId: "PVTI_3", ticketId: "3", issueNumber: 3, title: "Three", changeName: "three-3", startPhase: "specify" },
      ],
      maxStarts: 2,
      taskQueue: "pickup-queue",
    });
  });

  it("skips the starter activity when the board is empty", async () => {
    mockScanBoard.mockResolvedValue({ items: [] });

    await pickupWorkflow(2);

    expect(mockStartTicketWorkflows).not.toHaveBeenCalled();
  });
});