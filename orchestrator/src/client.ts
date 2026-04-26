import { Connection, Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { nanoid } from 'nanoid';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_BLOCKED_STATUS,
  DEFAULT_FILE_PATH_PREFIX,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_STATUS,
  TASK_QUEUE,
  type AutomateReadyIssueInput,
} from './shared';
import { automateTopReadyIssue } from './workflows';

async function run(): Promise<void> {
  console.log('Running github issue automation');

  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  try {
    const client = new Client({ connection });
    const handle = await client.workflow.start(automateTopReadyIssue, {
      taskQueue: TASK_QUEUE,
      args: [parseGithubWorkflowInput(process.argv.slice(2))],
      workflowId: `workflow-${nanoid()}`,
    });
    console.log(`Started workflow ${handle.workflowId}`);
    console.log(await handle.result());
  } finally {
    await connection.close();
  }
}

function parseGithubWorkflowInput(args: string[]): AutomateReadyIssueInput {
  const [projectOwnerArg, projectNumberArg] = args;
  const projectOwner = projectOwnerArg ?? process.env.GITHUB_PROJECT_OWNER;
  const projectNumberRaw = projectNumberArg ?? process.env.GITHUB_PROJECT_NUMBER;

  if (!projectOwner || !projectNumberRaw) {
    throw new Error(
      'Usage: npm run workflow -- <project-owner> <project-number> or set GITHUB_PROJECT_OWNER and GITHUB_PROJECT_NUMBER.',
    );
  }

  const projectNumber = Number(projectNumberRaw);
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(`Invalid project number: ${projectNumberRaw}`);
  }

  return {
    projectOwner,
    projectNumber,
    readyStatusName: process.env.GITHUB_READY_STATUS ?? DEFAULT_READY_STATUS,
    inReviewStatusName: process.env.GITHUB_IN_REVIEW_STATUS ?? DEFAULT_IN_REVIEW_STATUS,
    blockedStatusName: process.env.GITHUB_BLOCKED_STATUS ?? DEFAULT_BLOCKED_STATUS,
    branchPrefix: process.env.GITHUB_BRANCH_PREFIX ?? DEFAULT_BRANCH_PREFIX,
    filePathPrefix: process.env.GITHUB_FILE_PATH_PREFIX ?? DEFAULT_FILE_PATH_PREFIX,
  };
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
