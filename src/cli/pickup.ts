import { parseArgs } from "node:util";
import { Connection, Client } from "@temporalio/client";
import { createGitHubClient } from "../github/factory.js";
import { deriveChangeName } from "../contracts/helpers.js";
import { handleWorkflowTrigger } from "../orchestration/webhook-bridge.js";
import { loadRepoLocalConfig } from "./shared.js";

const USAGE = `night-shift pickup

Usage:
  night-shift pickup [--config <path>] [--repo-root <path>]

Scans the project board for Backlog and Ready items and starts
a ticket workflow for each. Runs once (one-shot, no cron).

Exit codes:
  0  completed (items started or none found)
  1  unexpected error
  64 usage error
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        "repo-root": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
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

  try {
    const { config } = await loadRepoLocalConfig({
      ...(args.values.config !== undefined ? { explicitPath: args.values.config } : {}),
      ...(args.values["repo-root"] !== undefined ? { repoRoot: args.values["repo-root"] } : {}),
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

    const [backlogItems, readyItems] = await Promise.all([
      github.listItemsByStatus("Backlog"),
      github.listItemsByStatus("Ready"),
    ]);

    const allItems = [
      ...backlogItems.map((it) => ({ ...it, startPhase: "specify" as const })),
      ...readyItems.map((it) => ({ ...it, startPhase: "implement" as const })),
    ];
    allItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (allItems.length === 0) {
      process.stdout.write("No items to pick up\n");
      return 0;
    }

    const temporalConfig = config.temporal;
    const maxReviewIterations = config.reviewPhase?.maxIterations ?? 3;
    const connection = await Connection.connect({
      address: temporalConfig.serverUrl,
    });
    const client = new Client({ connection, namespace: temporalConfig.namespace });

    let started = 0;
    let signaled = 0;
    let skipped = 0;

    for (const item of allItems) {
      const changeName = deriveChangeName(item.title, item.issueNumber);
      const workflowId = `ticket-${item.ticketId}`;
      const result = await handleWorkflowTrigger(
        {
          action: "pickup.scan",
          currentStatus: item.startPhase === "specify" ? "Backlog" : "Ready",
          itemId: item.itemId,
          ticketId: item.ticketId,
          changeName,
        },
        client,
        temporalConfig.taskQueue,
        maxReviewIterations,
      );

      if (result.action === "started") {
        process.stdout.write(`Started: ${workflowId} (${item.startPhase}) — ${item.title}\n`);
        started++;
        continue;
      }

      if (result.action === "signaled") {
        process.stdout.write(`Signaled: ${workflowId} (${result.signal}) — ${item.title}\n`);
        signaled++;
        continue;
      }

      process.stdout.write(`Skipped: ${workflowId} (already running)\n`);
      skipped++;
    }

    process.stdout.write(`\nSummary: ${started} started, ${signaled} signaled, ${skipped} skipped\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /pickup\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
