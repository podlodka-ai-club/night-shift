import type { Client, WorkflowHandle } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { BlockedReason, TicketWorkflowInput } from "./workflow.js";

export interface WebhookEvent {
  action: string;
  /** The new status after the transition */
  currentStatus: string;
  /** Project item node ID */
  itemId: string;
  ticketId: string;
  changeName: string;
}

export interface HandleResult {
  action: "started" | "signaled" | "ignored";
  workflowId?: string;
  signal?: string;
}

export async function handleWorkflowTrigger(
  event: WebhookEvent,
  client: Client,
  taskQueue: string,
): Promise<HandleResult> {
  const workflowId = `ticket-${event.ticketId}`;

  if (event.currentStatus === "Backlog") {
    return handleBacklog(event, client, taskQueue, workflowId);
  }
  if (event.currentStatus === "Ready") {
    return handleReady(client, workflowId);
  }
  if (event.currentStatus === "In review") {
    return handleInReview(client, workflowId);
  }

  return { action: "ignored" };
}

async function handleBacklog(
  event: WebhookEvent,
  client: Client,
  taskQueue: string,
  workflowId: string,
): Promise<HandleResult> {
  // Try to start a new workflow
  const input: TicketWorkflowInput = {
    itemId: event.itemId,
    ticketId: event.ticketId,
    changeName: event.changeName,
  };

  try {
    await client.workflow.start("ticketWorkflow", {
      taskQueue,
      workflowId,
      args: [input],
    });
    return { action: "started", workflowId };
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }

  // Workflow already exists — check if it's blocked and needs a signal
  const reason = await queryBlockedReason(client, workflowId);
  if (reason === "specify_needs_input" || reason === "awaiting_spec_review") {
    await signalWorkflow(client, workflowId, "specifyRetry");
    return { action: "signaled", workflowId, signal: "specifyRetry" };
  }

  return { action: "ignored", workflowId };
}

async function handleReady(client: Client, workflowId: string): Promise<HandleResult> {
  const reason = await queryBlockedReason(client, workflowId);
  if (reason === "awaiting_spec_review") {
    await signalWorkflow(client, workflowId, "specReviewed");
    return { action: "signaled", workflowId, signal: "specReviewed" };
  }
  if (reason === "implement_needs_input") {
    await signalWorkflow(client, workflowId, "implementRetry");
    return { action: "signaled", workflowId, signal: "implementRetry" };
  }
  return { action: "ignored", workflowId };
}

async function handleInReview(client: Client, workflowId: string): Promise<HandleResult> {
  const reason = await queryBlockedReason(client, workflowId);
  if (reason === "review_escalation") {
    await signalWorkflow(client, workflowId, "resume");
    return { action: "signaled", workflowId, signal: "resume" };
  }
  return { action: "ignored", workflowId };
}

async function queryBlockedReason(client: Client, workflowId: string): Promise<BlockedReason> {
  const handle: WorkflowHandle = client.workflow.getHandle(workflowId);
  return handle.query<BlockedReason>("getBlockedReason");
}

async function signalWorkflow(client: Client, workflowId: string, signalName: string): Promise<void> {
  const handle: WorkflowHandle = client.workflow.getHandle(workflowId);
  await handle.signal(signalName);
}
