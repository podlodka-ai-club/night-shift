import type { Client, WorkflowHandle } from "@temporalio/client";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
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
  maxReviewIterations: number = 3,
): Promise<HandleResult> {
  const workflowId = `ticket-${event.ticketId}`;

  if (event.currentStatus === "Backlog") {
    return handleBacklog(event, client, taskQueue, workflowId, maxReviewIterations);
  }
  if (event.currentStatus === "Ready") {
    return handleReady(event, client, taskQueue, workflowId, maxReviewIterations);
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
  maxReviewIterations: number,
): Promise<HandleResult> {
  // Try to start a new workflow
  const input: TicketWorkflowInput = {
    itemId: event.itemId,
    ticketId: event.ticketId,
    changeName: event.changeName,
    maxReviewIterations,
  };

  try {
    await client.workflow.start("ticketWorkflow", {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
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

async function handleReady(
  event: WebhookEvent,
  client: Client,
  taskQueue: string,
  workflowId: string,
  maxReviewIterations: number,
): Promise<HandleResult> {
  let reason: BlockedReason;
  try {
    reason = await queryBlockedReason(client, workflowId);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return startReadyWorkflow(event, client, taskQueue, workflowId, maxReviewIterations);
    }
    throw err;
  }

  if (reason === "awaiting_spec_review") {
    await signalWorkflow(client, workflowId, "specReviewed");
    return { action: "signaled", workflowId, signal: "specReviewed" };
  }
  if (reason === "implement_needs_input") {
    await signalWorkflow(client, workflowId, "implementRetry");
    return { action: "signaled", workflowId, signal: "implementRetry" };
  }
  if (reason === "review_escalation") {
    await signalWorkflow(client, workflowId, "resume");
    return { action: "signaled", workflowId, signal: "resume" };
  }

  // Closed runs can still answer queries, so fall back to a fresh implement start
  // unless the current workflow is at a resumable human gate handled above.
  return startReadyWorkflow(event, client, taskQueue, workflowId, maxReviewIterations);
}

async function startReadyWorkflow(
  event: WebhookEvent,
  client: Client,
  taskQueue: string,
  workflowId: string,
  maxReviewIterations: number,
): Promise<HandleResult> {
  const input: TicketWorkflowInput = {
    itemId: event.itemId,
    ticketId: event.ticketId,
    changeName: event.changeName,
    maxReviewIterations,
    startPhase: "implement",
  };

  try {
    await client.workflow.start("ticketWorkflow", {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      args: [input],
    });
    return { action: "started", workflowId };
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }

  const reason = await queryBlockedReason(client, workflowId);
  if (reason === "awaiting_spec_review") {
    await signalWorkflow(client, workflowId, "specReviewed");
    return { action: "signaled", workflowId, signal: "specReviewed" };
  }
  if (reason === "implement_needs_input") {
    await signalWorkflow(client, workflowId, "implementRetry");
    return { action: "signaled", workflowId, signal: "implementRetry" };
  }
  if (reason === "review_escalation") {
    await signalWorkflow(client, workflowId, "resume");
    return { action: "signaled", workflowId, signal: "resume" };
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
