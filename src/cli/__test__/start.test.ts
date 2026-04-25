import { describe, expect, it, vi, beforeEach } from "vitest";
import { main } from "../start.js";

// Mock all heavy dependencies
vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    roles: {},
    temporal: { serverUrl: "localhost:7233", namespace: "default", taskQueue: "night-shift" },
  }),
}));

const mockGetItem = vi.fn().mockResolvedValue({
  itemId: "PVTI_abc",
  projectNodeId: "PVT_1",
  ticketId: "42",
  title: "Fix login",
  issueNumber: 42,
  status: "Backlog",
});

vi.mock("../../github/factory.js", () => ({
  createGitHubClient: vi.fn().mockResolvedValue({
    getItem: (...args: unknown[]) => mockGetItem(...args),
  }),
}));

const mockStart = vi.fn().mockResolvedValue({
  workflowId: "ticket-42",
  firstExecutionRunId: "run-abc",
});
const mockGetHandle = vi.fn().mockReturnValue({ workflowId: "ticket-42" });

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
        getHandle: (...args: unknown[]) => mockGetHandle(...args),
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
  mockStart.mockReset().mockResolvedValue({
    workflowId: "ticket-42",
    firstExecutionRunId: "run-abc",
  });
});

describe("night-shift start CLI", () => {
  it("starts workflow and prints run ID", async () => {
    const code = await main(["PVTI_abc", "--change", "my-change"], {});
    expect(code).toBe(0);
    expect(stdout).toContain("ticket-42");
    expect(stdout).toContain("run-abc");
  });

  it("duplicate is idempotent (exit 0)", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-42", "ticketWorkflow"));

    const code = await main(["PVTI_abc", "--change", "my-change"], {});
    expect(code).toBe(0);
    expect(stdout).toContain("already running");
  });

  it("missing item ID prints usage and exits 64", async () => {
    const code = await main(["--change", "c"], {});
    expect(code).toBe(64);
    expect(stderr).toContain("missing");
  });

  it("missing --change prints usage and exits 64", async () => {
    const code = await main(["PVTI_abc"], {});
    expect(code).toBe(64);
    expect(stderr).toContain("missing");
  });
});
