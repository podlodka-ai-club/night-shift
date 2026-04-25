import { parseArgs } from "node:util";
import { Connection, Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { loadConfig } from "../config/loader.js";
import { createGitHubClient } from "../github/factory.js";
import type { TicketWorkflowInput } from "../orchestration/workflow.js";

const USAGE = `night-shift start

Usage:
  night-shift start <projectItemId> --change <change-name>
                    [--config <path>] [--profile <id>]

Starts a ticket workflow for the given project item.

Exit codes:
  0  workflow started (or already running)
  1  unexpected error
  64 usage error
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        change: { type: "string" },
        config: { type: "string" },
        profile: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 64;
  }
  if (args.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const projectItemId = args.positionals[0];
  const changeName = args.values.change;
  if (!projectItemId || !changeName) {
    process.stderr.write(`missing <projectItemId> or --change\n\n${USAGE}`);
    return 64;
  }

  try {
    const config = await loadConfig({
      ...(args.values.config !== undefined ? { explicitPath: args.values.config } : {}),
    });

    const githubInput = config.github ?? {
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      projectNodeId: env.GITHUB_PROJECT_NODE_ID,
    };
    const github = await createGitHubClient(githubInput);

    const item = await github.getItem(projectItemId);

    const temporalConfig = config.temporal;
    const connection = await Connection.connect({
      address: temporalConfig.serverUrl,
    });
    const client = new Client({ connection, namespace: temporalConfig.namespace });

    const workflowId = `ticket-${item.ticketId}`;
    const input: TicketWorkflowInput = {
      itemId: projectItemId,
      ticketId: item.ticketId,
      changeName,
      ...(args.values.profile !== undefined ? { profileId: args.values.profile } : {}),
    };

    try {
      const handle = await client.workflow.start("ticketWorkflow", {
        taskQueue: temporalConfig.taskQueue,
        workflowId,
        args: [input],
      });
      process.stdout.write(`Workflow started: ${handle.workflowId} (run: ${handle.firstExecutionRunId})\n`);
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        const existing = client.workflow.getHandle(workflowId);
        process.stdout.write(`Workflow already running: ${existing.workflowId}\n`);
        return 0;
      }
      throw err;
    }

    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /start\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
