import { Worker, NativeConnection } from "@temporalio/worker";
import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleClient,
  ScheduleOverlapPolicy,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { fileURLToPath } from "node:url";
import type { ResolvedNightShiftConfig } from "../config/schema.js";
import { setActivityDepsFactory, type ActivityDepsFactory } from "./activities.js";
import * as activities from "./activities.js";
import * as pickupActivities from "./pickup-activities.js";
import type { GitHubClient } from "../github/client.js";

const WORKFLOWS_PATH = fileURLToPath(new URL("./workflow.ts", import.meta.url));
const ORCHESTRATION_DIR = fileURLToPath(new URL("./", import.meta.url));
const TEMPORAL_TYPESCRIPT_LOADER_PATH = fileURLToPath(new URL("./temporal-typescript-loader.cjs", import.meta.url));
const PICKUP_SCHEDULE_ID = "pickup-schedule";
const LEGACY_PICKUP_CRON_WORKFLOW_ID = "pickup-cron";

function addWorkflowTypeScriptLoader(config: any): any {
  const existingRules = Array.isArray(config.module?.rules) ? config.module.rules : [];

  return {
    ...config,
    module: {
      ...config.module,
      rules: [
        ...existingRules,
        {
          test: /\.ts$/,
          include: [ORCHESTRATION_DIR],
          use: [{ loader: TEMPORAL_TYPESCRIPT_LOADER_PATH }],
        },
      ],
    },
  };
}

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
    pickupActivities.setPickupTemporalConfig(
      temporalConfig.serverUrl,
      temporalConfig.namespace,
      config.reviewPhase?.maxIterations ?? 3,
    );
    Object.assign(allActivities, pickupActivities);
  }

  const connection = await NativeConnection.connect({
    address: temporalConfig.serverUrl,
  });

  const worker = await Worker.create({
    connection,
    namespace: temporalConfig.namespace,
    taskQueue: temporalConfig.taskQueue,
    workflowsPath: WORKFLOWS_PATH,
    bundlerOptions: {
      webpackConfigHook: addWorkflowTypeScriptLoader,
    },
    activities: allActivities,
  });

  return worker;
}

async function stopLegacyPickupCronWorkflow(client: Client): Promise<void> {
  try {
    await client.workflow.getHandle(LEGACY_PICKUP_CRON_WORKFLOW_ID).terminate("Pickup cron migrated to schedule");
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return;
    }
    throw err;
  }
}

export async function startPickupSchedule(opts: {
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
  const scheduleClient = new ScheduleClient({ connection: clientConnection, namespace: temporalConfig.namespace });

  await stopLegacyPickupCronWorkflow(client);

  const scheduleOptions = {
    scheduleId: PICKUP_SCHEDULE_ID,
    spec: {
      intervals: [{ every: `${pickup.intervalSeconds}s` }],
    },
    action: {
      type: "startWorkflow" as const,
      workflowType: "pickupWorkflow",
      taskQueue: temporalConfig.taskQueue,
      args: [pickup.maxConcurrent],
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
    },
  };

  try {
    await scheduleClient.create({
      ...scheduleOptions,
      state: { triggerImmediately: true },
    });
  } catch (err: unknown) {
    if (err instanceof ScheduleAlreadyRunning) {
      const handle = scheduleClient.getHandle(PICKUP_SCHEDULE_ID);
      await handle.update(() => scheduleOptions);
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
      return;
    }
    throw err;
  }
}

export async function runWorkerUntilShutdown(worker: Worker): Promise<void> {
  const shutdown = () => worker.shutdown();
  let failedStateInterval: NodeJS.Timeout | undefined;

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await Promise.race([
      worker.run(),
      new Promise<never>((_, reject) => {
        failedStateInterval = setInterval(() => {
          if (worker.getState() !== "FAILED") {
            return;
          }

          worker.shutdown();
          reject(new Error("Temporal worker entered FAILED state"));
        }, 250);
      }),
    ]);
  } finally {
    if (failedStateInterval) {
      clearInterval(failedStateInterval);
    }
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
