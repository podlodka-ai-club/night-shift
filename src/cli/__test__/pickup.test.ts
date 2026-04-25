import { describe, expect, it, vi, beforeEach } from "vitest";
import { main } from "../pickup.js";

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    roles: {},
    temporal: { serverUrl: "localhost:7233", namespace: "default", taskQueue: "night-shift" },
  }),
}));

const mockListItemsByStatus = vi.fn();

vi.mock("../../github/factory.js", () => ({
  createGitHubClient: vi.fn().mockResolvedValue({
    listItemsByStatus: (...args: unknown[]) => mockListItemsByStatus(...args),
  }),
}));

const mockStart = vi.fn();

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
      },
    })),
    WorkflowExecutionAlreadyStartedError,
  };
});

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { stdout += s; return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => { stderr += s; return true; });
  mockStart.mockReset().mockResolvedValue({ workflowId: "ticket-1" });
  mockListItemsByStatus.mockReset();
});

describe("night-shift pickup CLI", () => {
  it("discovers items from both statuses and starts workflows", async () => {
    mockListItemsByStatus
      .mockResolvedValueOnce([
        { itemId: "PVTI_1", issueNumber: 1, title: "Fix login", ticketId: "1", createdAt: "2026-01-01T00:00:00Z" },
      ])
      .mockResolvedValueOnce([
        { itemId: "PVTI_2", issueNumber: 2, title: "Add tests", ticketId: "2", createdAt: "2026-01-02T00:00:00Z" },
      ]);

    const code = await main([], {});
    expect(code).toBe(0);
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(stdout).toContain("Started: ticket-1");
    expect(stdout).toContain("Started: ticket-2");
    expect(stdout).toContain("2 started");
  });

  it("prints 'No items to pick up' and exits 0 when board is empty", async () => {
    mockListItemsByStatus.mockResolvedValue([]);

    const code = await main([], {});
    expect(code).toBe(0);
    expect(stdout).toContain("No items to pick up");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("exits 64 on usage error (invalid argument)", async () => {
    const code = await main(["--bogus"], {});
    expect(code).toBe(64);
    expect(stderr).toContain("Unknown option");
  });

  it("skips already-running workflows", async () => {
    mockListItemsByStatus
      .mockResolvedValueOnce([
        { itemId: "PVTI_1", issueNumber: 1, title: "Fix login", ticketId: "1", createdAt: "2026-01-01T00:00:00Z" },
      ])
      .mockResolvedValueOnce([]);

    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-1", "ticketWorkflow"));

    const code = await main([], {});
    expect(code).toBe(0);
    expect(stdout).toContain("Skipped: ticket-1");
    expect(stdout).toContain("0 started, 1 skipped");
  });
});
