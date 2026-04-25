import { Worker, NativeConnection } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import type { ResolvedNightShiftConfig } from "../config/schema.js";
import { setActivityDepsFactory, type ActivityDepsFactory } from "./activities.js";
import * as activities from "./activities.js";
import * as pickupActivities from "./pickup-activities.js";
import type { GitHubClient } from "../github/client.js";

export interface StartWorkerOpts {
  config: ResolvedNightShiftConfig;
  depsFactory: ActivityDepsFactory;
  github?: GitHubClient;
}

export async function startWorker(opts: StartWorkerOpts): Promise<Worker> {
  const { config, depsFactory } = opts;
  const temporalConfig = config.temporal;

  setActivityDepsFactory(depsFactory);

  const allActivities: Record<string, unknown> = { ...activities };

  if (config.pickup?.enabled && opts.github) {
    pickupActivities.setPickupGitHubClient(opts.github);
    pickupActivities.setPickupTemporalConfig(temporalConfig.serverUrl, temporalConfig.namespace);
    Object.assign(allActivities, pickupActivities);
  }

  const connection = await NativeConnection.connect({
    address: temporalConfig.serverUrl,
  });

  const worker = await Worker.create({
    connection,
    namespace: temporalConfig.namespace,
    taskQueue: temporalConfig.taskQueue,
    workflowsPath: new URL("./workflow.ts", import.meta.url).pathname,
    activities: allActivities,
  });

  return worker;
}

export async function startPickupCronWorkflow(opts: {
  config: ResolvedNightShiftConfig;
}): Promise<void> {
  const { config } = opts;
  const pickup = config.pickup;
  if (!pickup?.enabled) return;

  const temporalConfig = config.temporal;
  const clientConnection = await Connection.connect({
    address: temporalConfig.serverUrl,
  });
  const client = new Client({ connection: clientConnection, namespace: temporalConfig.namespace });

  const cronSchedule = `*/${pickup.intervalMinutes} * * * *`;

  try {
    await client.workflow.start("pickupWorkflow", {
      taskQueue: temporalConfig.taskQueue,
      workflowId: "pickup-cron",
      cronSchedule,
      args: [pickup.maxConcurrent],
    });
  } catch (err: unknown) {
    // Ignore if already running
    if (
      err != null &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name: string }).name === "WorkflowExecutionAlreadyStartedError"
    ) {
      // Cron already exists — fall through to fire immediate run
    } else {
      throw err;
    }
  }

  // Fire an immediate one-off pickup so we don't wait for the first cron tick.
  try {
    await client.workflow.start("pickupWorkflow", {
      taskQueue: temporalConfig.taskQueue,
      workflowId: `pickup-immediate-${Date.now()}`,
      args: [pickup.maxConcurrent],
    });
  } catch {
    // Best-effort — cron will catch up regardless
  }
}

export async function runWorkerUntilShutdown(worker: Worker): Promise<void> {
  const shutdown = () => worker.shutdown();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await worker.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
