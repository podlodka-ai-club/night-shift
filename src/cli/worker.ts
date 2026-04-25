import { parseArgs } from "node:util";
import { loadConfig } from "../config/loader.js";
import { startWorker, startPickupCronWorkflow, runWorkerUntilShutdown } from "../orchestration/worker.js";
import { createGitHubClient } from "../github/factory.js";
import type { ActivityDepsFactory } from "../orchestration/activities.js";

const USAGE = `night-shift worker

Usage:
  night-shift worker [--config <path>]

Starts the Temporal worker that processes ticket workflows.

Exit codes:
  0  clean shutdown
  1  unexpected error
  64 usage error
`;

export async function main(argv: string[], _env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
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
    const config = await loadConfig({
      ...(args.values.config !== undefined ? { explicitPath: args.values.config } : {}),
    });

    // Build a deps factory that creates phase deps from config + env.
    // This is a placeholder — the real factory will be built in a follow-up
    // once phase dep construction is extracted from CLIs.
    const depsFactory: ActivityDepsFactory = {
      buildSpecifyDeps: () => { throw new Error("Not yet implemented: specify deps factory"); },
      buildImplementDeps: () => { throw new Error("Not yet implemented: implement deps factory"); },
      buildReviewDeps: () => { throw new Error("Not yet implemented: review deps factory"); },
    };

    // Create GitHub client if configured
    let github;
    if (config.github) {
      try {
        github = await createGitHubClient(config.github);
        process.stdout.write("GitHub client connected\n");
      } catch (err) {
        process.stderr.write(`Warning: GitHub client failed: ${(err as Error).message}\n`);
      }
    }

    const worker = await startWorker({ config, depsFactory, ...(github ? { github } : {}) });
    process.stdout.write("Worker started\n");

    if (config.pickup?.enabled) {
      if (github) {
        await startPickupCronWorkflow({ config });
        process.stdout.write(`Pickup cron started (every ${config.pickup.intervalMinutes}m, max ${config.pickup.maxConcurrent} concurrent)\n`);
      } else {
        process.stderr.write("Warning: pickup.enabled is true but no GitHub client available — pickup cron not started\n");
      }
    }

    await runWorkerUntilShutdown(worker);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /worker\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
