import { parseArgs } from "node:util";
import path from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { simpleGit } from "simple-git";
import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "../config/loader.js";
import { startWorker, startPickupCronWorkflow, runWorkerUntilShutdown } from "../orchestration/worker.js";
import { createGitHubClient } from "../github/factory.js";
import type { GitHubClient } from "../github/client.js";
import { createSimpleGitOps } from "../git/index.js";
import { createSimpleGitWorktreeOps } from "../worktree/index.js";
import { createNodeQualityGateRunner, type QualityGate } from "../quality-gates/index.js";
import { CodexAdapter, ClaudeAgentAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/events.js";
import { createOpenSpecCli } from "../phases/specify/openspec-cli.js";
import type { SpecifyFs } from "../phases/specify/phase.js";
import type { ImplementFs } from "../phases/implement/phase.js";
import type { ReviewFs } from "../phases/review/phase.js";
import type { ActivityDepsFactory } from "../orchestration/activities.js";
import type { ResolvedNightShiftConfig } from "../config/schema.js";

const USAGE = `night-shift worker

Usage:
  night-shift worker [--config <path>]

Starts the Temporal worker that processes ticket workflows.

Exit codes:
  0  clean shutdown
  1  unexpected error
  64 usage error
`;

function makeAdapter(provider: string): AgentAdapter {
  return provider === "claude-agent" ? new ClaudeAgentAdapter() : new CodexAdapter();
}

function makeSpecifyFs(repoRoot: string): SpecifyFs {
  return {
    async readPriorDraft(worktreePath, changeDir) {
      const base = path.join(worktreePath, changeDir);
      try {
        const out: Array<{ path: string; content: string }> = [];
        const walk = async (dir: string, rel: string): Promise<void> => {
          const entries = await readdir(dir);
          for (const e of entries) {
            const full = path.join(dir, e);
            const r = path.posix.join(rel, e);
            const s = await stat(full);
            if (s.isDirectory()) await walk(full, r);
            else out.push({ path: r, content: await readFile(full, "utf8") });
          }
        };
        await walk(base, "");
        return out;
      } catch {
        return [];
      }
    },
  };
}

function makeImplementFs(): ImplementFs {
  return {
    async readSpecBundle(specPath) {
      const out: Array<{ path: string; content: string }> = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.join(dir, e);
          const r = rel ? path.posix.join(rel, e) : e;
          const s = await stat(full);
          if (s.isDirectory()) await walk(full, r);
          else out.push({ path: path.posix.join(specPath, r), content: await readFile(full, "utf8") });
        }
      };
      await walk(specPath, "");
      return out;
    },
    async writeWorktreeFiles(worktreePath, files) {
      for (const f of files) {
        const full = path.join(worktreePath, f.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, f.content, "utf8");
      }
    },
  };
}

function makeReviewFs(): ReviewFs {
  return {
    async readFile(filePath: string): Promise<string> {
      return readFile(filePath, "utf8");
    },
  };
}

function defaultQualityGates(): QualityGate[] {
  return [
    { name: "typecheck", command: ["npm", "run", "typecheck"] },
    { name: "lint", command: ["npm", "run", "lint:boundaries"], optional: true },
    { name: "test", command: ["npm", "test"] },
  ];
}

function buildDepsFactory(
  config: ResolvedNightShiftConfig,
  github: GitHubClient,
  repoRoot: string,
): ActivityDepsFactory {
  let signalClientPromise: Promise<Client> | undefined;
  const openspecCli = createOpenSpecCli();

  async function getSignalClient(): Promise<Client> {
    if (!signalClientPromise) {
      signalClientPromise = Connection.connect({ address: config.temporal.serverUrl })
        .then((connection) => new Client({
          connection,
          namespace: config.temporal.namespace,
        }));
    }
    return signalClientPromise;
  }

  return {
    buildSpecifyDeps(runId, profileId) {
      const roleConfig = config.roles.specifier;
      if (!roleConfig) throw new Error("config.roles.specifier is not defined");
      const gitInstance = simpleGit(repoRoot);
      return {
        github,
        worktree: createSimpleGitWorktreeOps({ repoRoot, git: gitInstance }),
        gitForRepo: (scopedRepoRoot: string) =>
          createSimpleGitOps({ repoRoot: scopedRepoRoot, git: simpleGit(scopedRepoRoot) }),
        fs: makeSpecifyFs(repoRoot),
        agent: makeAdapter(roleConfig.provider),
        openspecCli,
        baseBranch: "main",
        runId,
        profileId,
        model: roleConfig.model,
      };
    },
    buildImplementDeps(runId, profileId) {
      const roleConfig = config.roles.implementer;
      if (!roleConfig) throw new Error("config.roles.implementer is not defined");
      const gitInstance = simpleGit(repoRoot);
      return {
        github,
        git: createSimpleGitOps({ repoRoot, git: gitInstance }),
        gitForRepo: (scopedRepoRoot: string) =>
          createSimpleGitOps({ repoRoot: scopedRepoRoot, git: simpleGit(scopedRepoRoot) }),
        fs: makeImplementFs(),
        worktree: createSimpleGitWorktreeOps({ repoRoot, git: gitInstance }),
        gateRunner: createNodeQualityGateRunner(),
        agent: makeAdapter(roleConfig.provider),
        runId,
        profileId,
        implementerModel: roleConfig.model,
        qualityGates: defaultQualityGates(),
        baseBranch: "main",
      };
    },
    buildReviewDeps(runId, profileId) {
      const roleConfig = config.roles.reviewer;
      if (!roleConfig) throw new Error("config.roles.reviewer is not defined");
      return {
        github,
        agent: makeAdapter(roleConfig.provider),
        fs: makeReviewFs(),
        clock: { now: () => new Date() },
        config,
        runId,
        profileId,
        reviewerModel: roleConfig.model,
        workingDirectory: repoRoot,
      };
    },
    async signalProgress(workflowId, md) {
      const client = await getSignalClient();
      await client.workflow.getHandle(workflowId).signal("activityProgress", md);
    },
  };
}

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
    const repoRoot = path.resolve(config.repoRoot ?? process.cwd());

    // Create GitHub client
    let github: GitHubClient | undefined;
    if (config.github) {
      try {
        github = await createGitHubClient(config.github);
        process.stdout.write("GitHub client connected\n");
      } catch (err) {
        process.stderr.write(`Warning: GitHub client failed: ${(err as Error).message}\n`);
      }
    }

    // Build a deps factory that creates phase deps from config + env.
    if (!github) {
      process.stderr.write("Error: GitHub client is required for the worker\n");
      return 1;
    }
    const depsFactory = buildDepsFactory(config, github, repoRoot);

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
