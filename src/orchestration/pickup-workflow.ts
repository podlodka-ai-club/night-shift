import {
  proxyActivities,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { scanBoardActivity } from "./pickup-activities.js";
import type { TicketWorkflowInput } from "./workflow.js";

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

export async function pickupWorkflow(maxConcurrent: number): Promise<void> {
  const result = await scanBoard();

  const toStart = result.items.slice(0, maxConcurrent);

  for (const item of toStart) {
    const workflowId = `ticket-${item.ticketId}`;
    const input: TicketWorkflowInput = {
      itemId: item.itemId,
      ticketId: item.ticketId,
      changeName: item.changeName,
      startPhase: item.startPhase,
    };

    try {
      await startChild("ticketWorkflow", {
        workflowId,
        args: [input],
        taskQueue: workflowInfo().taskQueue,
      });
    } catch (err: unknown) {
      // WorkflowExecutionAlreadyStartedError — silently ignore
      if (
        err != null &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name: string }).name === "WorkflowExecutionAlreadyStartedError"
      ) {
        continue;
      }
      throw err;
    }
  }
}
