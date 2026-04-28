import { Connection, Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { createActivityDependencies } from './activities';
import { createGitHubActivities } from './activity-github';
import {
  DEFAULT_BACKLOG_STATUS,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_BLOCKED_STATUS,
  DEFAULT_FILE_PATH_PREFIX,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_STATUS,
  type AutomateReadyIssueInput,
  type ProjectStatusName,
} from './shared';
import {
  createTemporalWorkflowTriggerDeps,
  handleWorkflowTrigger,
  loadManualCandidate,
  loadPickupCandidates,
  runPickupIntake,
} from './intake';

type IntakeCommand = { kind: 'pickup'; maxActions: number } | { kind: 'manual'; statusName: ProjectStatusName };

async function run(): Promise<void> {
  console.log('Running github issue automation');
  const { workflowInput, command } = parseClientArgs(process.argv.slice(2));

  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  try {
    const client = new Client({ connection });
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

function parseClientArgs(args: string[]): { workflowInput: AutomateReadyIssueInput; command: IntakeCommand } {
  const [projectOwnerArg, projectNumberArg, modeOrStatusArg, maxActionsArg] = args;
  const projectOwner = projectOwnerArg ?? process.env.GITHUB_PROJECT_OWNER;
  const projectNumberRaw = projectNumberArg ?? process.env.GITHUB_PROJECT_NUMBER;

  if (!projectOwner || !projectNumberRaw) {
    throw new Error(
      'Usage: npm run workflow -- <project-owner> <project-number> [pickup|Backlog|Ready|"In review"] [max-actions]',
    );
  }

  const projectNumber = Number(projectNumberRaw);
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(`Invalid project number: ${projectNumberRaw}`);
  }

  const workflowInput: AutomateReadyIssueInput = {
    projectOwner,
    projectNumber,
    backlogStatusName: process.env.GITHUB_BACKLOG_STATUS ?? DEFAULT_BACKLOG_STATUS,
    readyStatusName: process.env.GITHUB_READY_STATUS ?? DEFAULT_READY_STATUS,
    inReviewStatusName: process.env.GITHUB_IN_REVIEW_STATUS ?? DEFAULT_IN_REVIEW_STATUS,
    blockedStatusName: process.env.GITHUB_BLOCKED_STATUS ?? DEFAULT_BLOCKED_STATUS,
    branchPrefix: process.env.GITHUB_BRANCH_PREFIX ?? DEFAULT_BRANCH_PREFIX,
    filePathPrefix: process.env.GITHUB_FILE_PATH_PREFIX ?? DEFAULT_FILE_PATH_PREFIX,
  };

  if (!modeOrStatusArg || modeOrStatusArg === 'pickup') {
    const maxActionsRaw = maxActionsArg ?? process.env.GITHUB_PICKUP_MAX_ACTIONS ?? '1';
    const maxActions = Number(maxActionsRaw);
    if (!Number.isInteger(maxActions) || maxActions <= 0) {
      throw new Error(`Invalid pickup max-actions value: ${maxActionsRaw}`);
    }
    return { workflowInput, command: { kind: 'pickup', maxActions } };
  }

  if (modeOrStatusArg === 'Backlog' || modeOrStatusArg === 'Ready' || modeOrStatusArg === 'In review') {
    return { workflowInput, command: { kind: 'manual', statusName: modeOrStatusArg } };
  }

  throw new Error(`Unsupported intake mode or status: ${modeOrStatusArg}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
