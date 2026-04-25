import {
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import type { scanBoardActivity, startTicketWorkflowsActivity } from "./pickup-activities.js";

const { scanBoardActivity: scanBoard } = proxyActivities<{
  scanBoardActivity: typeof scanBoardActivity;
}>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 3,
  },
});

const { startTicketWorkflowsActivity: startTicketWorkflows } = proxyActivities<{
  startTicketWorkflowsActivity: typeof startTicketWorkflowsActivity;
}>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 3,
  },
});

export async function pickupWorkflow(maxConcurrent: number): Promise<void> {
  const result = await scanBoard();

  if (result.items.length > 0) {
    await startTicketWorkflows({
      items: result.items,
      maxStarts: maxConcurrent,
      taskQueue: workflowInfo().taskQueue,
    });
  }
}
