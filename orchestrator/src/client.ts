import { Connection, Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { createActivityDependencies } from './activities';
import { createGitHubActivities } from './activity-github';
import { loadClientEntrypointConfig, parseEntrypointConfigArgs } from './entrypoint-config';
import {
  createTemporalWorkflowTriggerDeps,
  handleWorkflowTrigger,
  loadManualCandidate,
  loadPickupCandidates,
  runPickupIntake,
} from './intake';

export async function run(args = process.argv.slice(2)): Promise<void> {
  console.log('Running github issue automation');
  const parsedArgs = parseEntrypointConfigArgs(args);
  const { temporal, workflowInput, command } = await loadClientEntrypointConfig({
    args: parsedArgs.args,
    explicitPath: parsedArgs.explicitPath,
  });

  const config = loadClientConnectConfig();
  const connection = await Connection.connect({
    ...config.connectionOptions,
    address: temporal.address,
  });
  try {
    const client = new Client({
      connection,
      namespace: temporal.namespace,
    });
    const workflowDeps = createTemporalWorkflowTriggerDeps(client.workflow);
    const githubActivities = createGitHubActivities(createActivityDependencies());

    if (command.kind === 'pickup') {
      const actions = await runPickupIntake(
        workflowDeps,
        workflowInput,
        await loadPickupCandidates(githubActivities, workflowInput),
        command.maxActions,
      );
      console.log(JSON.stringify(actions, null, 2));
      return;
    }

    const candidate = await loadManualCandidate(githubActivities, workflowInput, command.statusName);
    if (!candidate) {
      throw new Error(`Could not find a ${command.statusName} issue to intake in GitHub Project ${workflowInput.projectOwner}/${workflowInput.projectNumber}.`);
    }
    console.log(JSON.stringify(await handleWorkflowTrigger(workflowDeps, workflowInput, candidate), null, 2));
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
