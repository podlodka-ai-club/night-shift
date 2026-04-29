import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleClient,
  ScheduleOverlapPolicy,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, createActivityRuntimes } from './activities';
import {
  loadWorkerEntrypointConfig,
  parseEntrypointConfigArgs,
  type ResolvedWorkerEntrypointConfig,
} from './entrypoint-config';
import { createPickupActivities } from './pickup-activities';

export const PICKUP_SCHEDULE_ID = 'pickup-schedule';
const LEGACY_PICKUP_CRON_WORKFLOW_ID = 'pickup-cron';

export function buildPickupScheduleOptions(config: ResolvedWorkerEntrypointConfig) {
  return {
    scheduleId: PICKUP_SCHEDULE_ID,
    spec: {
      intervals: [{ every: `${config.pickup.intervalSeconds}s` }],
    },
    action: {
      type: 'startWorkflow' as const,
      workflowType: 'pickupWorkflow',
      taskQueue: config.temporal.taskQueue,
      args: [{ workflowInput: config.workflowInput, maxActions: config.pickup.maxConcurrent }],
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
    },
    state: {},
  };
}

export async function ensurePickupSchedule(
  deps: {
    stopLegacyPickupCronWorkflow(): Promise<void>;
    createSchedule(options: ReturnType<typeof buildPickupScheduleOptions> & { state: { triggerImmediately: true } }): Promise<void>;
    updateSchedule(options: ReturnType<typeof buildPickupScheduleOptions>): Promise<void>;
    triggerSchedule(overlap: ScheduleOverlapPolicy): Promise<void>;
    isScheduleAlreadyRunning(error: unknown): boolean;
  },
  options: ReturnType<typeof buildPickupScheduleOptions>,
): Promise<void> {
  await deps.stopLegacyPickupCronWorkflow();
  try {
    await deps.createSchedule({ ...options, state: { ...options.state, triggerImmediately: true } });
  } catch (error) {
    if (!deps.isScheduleAlreadyRunning(error)) {
      throw error;
    }
    await deps.updateSchedule(options);
    await deps.triggerSchedule(ScheduleOverlapPolicy.SKIP);
  }
}

export async function run(args = process.argv.slice(2)): Promise<void> {
  const parsedArgs = parseEntrypointConfigArgs(args);
  const config = await loadWorkerEntrypointConfig({ explicitPath: parsedArgs.explicitPath });
  const connection = await NativeConnection.connect({
    address: config.temporal.address,
  });
  try {
    const runtimes = createActivityRuntimes();
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      // Workflows are registered using a path as they run in a separate JS context.
      workflowsPath: require.resolve('./workflows'),
      activities: {
        ...createActivities(runtimes),
        ...createPickupActivities(runtimes.github, config.temporal),
      },
    });

    if (config.pickup.enabled) {
      await startPickupSchedule(config);
    }

    await worker.run();
  } finally {
    await connection.close();
  }
}

async function startPickupSchedule(config: ResolvedWorkerEntrypointConfig): Promise<void> {
  const connection = await Connection.connect({ address: config.temporal.address });
  try {
    const client = new Client({ connection, namespace: config.temporal.namespace });
    const scheduleClient = new ScheduleClient({ connection, namespace: config.temporal.namespace });
    const options = buildPickupScheduleOptions(config);
    await ensurePickupSchedule({
      async stopLegacyPickupCronWorkflow() {
        try {
          await client.workflow.getHandle(LEGACY_PICKUP_CRON_WORKFLOW_ID).terminate('Pickup cron migrated to schedule');
        } catch (error) {
          if (error instanceof WorkflowNotFoundError) return;
          throw error;
        }
      },
      async createSchedule(value) {
        await scheduleClient.create(value);
      },
      async updateSchedule(value) {
        await scheduleClient.getHandle(PICKUP_SCHEDULE_ID).update(() => value);
      },
      async triggerSchedule(value) {
        await scheduleClient.getHandle(PICKUP_SCHEDULE_ID).trigger(value);
      },
      isScheduleAlreadyRunning(error) {
        return error instanceof ScheduleAlreadyRunning;
      },
    }, options);
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
