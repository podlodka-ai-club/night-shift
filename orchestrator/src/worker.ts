import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, createActivityRuntimes } from './activities';
import {
  loadWorkerEntrypointConfig,
  parseEntrypointConfigArgs,
} from './entrypoint-config';

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
      activities: createActivities(runtimes),
    });

    await worker.run();
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
