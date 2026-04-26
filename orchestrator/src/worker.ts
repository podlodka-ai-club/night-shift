import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, createActivityRuntimes } from './activities';
import { TASK_QUEUE } from './shared';

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: 'localhost:7233',
  });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: TASK_QUEUE,
      // Workflows are registered using a path as they run in a separate JS context.
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities(createActivityRuntimes()),
    });

    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
