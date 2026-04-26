import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleWorkflowTrigger, type WebhookEvent } from "../webhook-bridge.js";

const mockStart = vi.fn();
const mockQuery = vi.fn();
const mockSignal = vi.fn();
const mockGetHandle = vi.fn().mockReturnValue({
  query: (...args: unknown[]) => mockQuery(...args),
  signal: (...args: unknown[]) => mockSignal(...args),
});

const fakeClient = {
  workflow: {
    start: (...args: unknown[]) => mockStart(...args),
    getHandle: (...args: unknown[]) => mockGetHandle(...args),
  },
} as any;

const baseEvent: WebhookEvent = {
  action: "project_v2_item.changed",
  currentStatus: "Backlog",
  itemId: "PVTI_abc",
  ticketId: "42",
  changeName: "my-change",
};

beforeEach(() => {
  mockStart.mockReset();
  mockQuery.mockReset();
  mockSignal.mockReset();
});

describe("handleWorkflowTrigger", () => {
  it("Backlog event starts new workflow", async () => {
    mockStart.mockResolvedValue({ workflowId: "ticket-42" });
    const result = await handleWorkflowTrigger(baseEvent, fakeClient, "q");
    expect(result).toEqual({ action: "started", workflowId: "ticket-42" });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("Backlog event signals specifyRetry on blocked workflow", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-42", "ticketWorkflow"));
    mockQuery.mockResolvedValue("specify_needs_input");

    const result = await handleWorkflowTrigger(baseEvent, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "specifyRetry" });
  });

  it("Backlog event signals specifyRetry on awaiting_spec_review (operator rejects spec)", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-42", "ticketWorkflow"));
    mockQuery.mockResolvedValue("awaiting_spec_review");

    const result = await handleWorkflowTrigger(baseEvent, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "specifyRetry" });
  });

  it("Ready event signals specReviewed", async () => {
    mockQuery.mockResolvedValue("awaiting_spec_review");
    const event = { ...baseEvent, currentStatus: "Ready" };

    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "specReviewed" });
  });

  it("Ready event signals implementRetry", async () => {
    mockQuery.mockResolvedValue("implement_needs_input");
    const event = { ...baseEvent, currentStatus: "Ready" };

    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "implementRetry" });
  });

  it("Ready event signals resume for review escalation", async () => {
    mockQuery.mockResolvedValue("review_escalation");
    const event = { ...baseEvent, currentStatus: "Ready" };

    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "resume" });
  });

  it("Ready event starts implement-phase workflow when none exists", async () => {
    const { WorkflowNotFoundError } = await import("@temporalio/client");
    mockQuery.mockRejectedValue(new WorkflowNotFoundError("missing", "ticket-42", "run-1"));
    mockStart.mockResolvedValue({ workflowId: "ticket-42" });

    const event = { ...baseEvent, currentStatus: "Ready" };
    const result = await handleWorkflowTrigger(event, fakeClient, "q");

    expect(result).toEqual({ action: "started", workflowId: "ticket-42" });
    expect(mockStart).toHaveBeenCalledWith("ticketWorkflow", expect.objectContaining({
      taskQueue: "q",
      workflowId: "ticket-42",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [expect.objectContaining({ startPhase: "implement" })],
    }));
  });

  it("Ready event starts a fresh implement run when the previous workflow is closed", async () => {
    mockQuery.mockResolvedValue(null);
    mockStart.mockResolvedValue({ workflowId: "ticket-42" });

    const event = { ...baseEvent, currentStatus: "Ready" };
    const result = await handleWorkflowTrigger(event, fakeClient, "q");

    expect(result).toEqual({ action: "started", workflowId: "ticket-42" });
    expect(mockStart).toHaveBeenCalledWith("ticketWorkflow", expect.objectContaining({
      taskQueue: "q",
      workflowId: "ticket-42",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [expect.objectContaining({ startPhase: "implement" })],
    }));
  });

  it("In-review event signals resume", async () => {
    mockQuery.mockResolvedValue("review_escalation");
    const event = { ...baseEvent, currentStatus: "In review" };

    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "signaled", workflowId: "ticket-42", signal: "resume" });
  });

  it("unrelated event is ignored", async () => {
    const event = { ...baseEvent, currentStatus: "Done" };
    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "ignored" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("duplicate Backlog start is idempotent", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-42", "ticketWorkflow"));
    mockQuery.mockResolvedValue(null);

    const result = await handleWorkflowTrigger(baseEvent, fakeClient, "q");
    expect(result).toEqual({ action: "ignored", workflowId: "ticket-42" });
  });

  it("Ready transition remains a no-op when a workflow with null blockedReason is still running", async () => {
    const { WorkflowExecutionAlreadyStartedError } = await import("@temporalio/client");
    mockQuery.mockResolvedValue(null);
    mockStart.mockRejectedValue(new WorkflowExecutionAlreadyStartedError("dup", "ticket-42", "ticketWorkflow"));
    const event = { ...baseEvent, currentStatus: "Ready" };

    const result = await handleWorkflowTrigger(event, fakeClient, "q");
    expect(result).toEqual({ action: "ignored", workflowId: "ticket-42" });
    expect(mockSignal).not.toHaveBeenCalled();
  });
});
