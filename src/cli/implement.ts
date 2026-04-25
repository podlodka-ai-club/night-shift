import { parseArgs } from "node:util";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { loadConfig } from "../config/loader.js";
import { CodexAdapter, ClaudeAgentAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/events.js";
import { createGitHubClient } from "../github/factory.js";
import { createSimpleGitOps } from "../git/index.js";
import { createSimpleGitWorktreeOps } from "../worktree/index.js";
import {
  createNodeQualityGateRunner,
  type QualityGate,
} from "../quality-gates/index.js";
import {
  runImplementPhase,
  type ImplementFs,
} from "../phases/implement/phase.js";
import { ImplementPhaseError } from "../phases/implement/errors.js";

const USAGE = `night-shift implement

Usage:
  night-shift implement --item <projectItemId> --change <change-name>
                        [--config <path>] [--repo-root <path>]
                        [--run-id <id>] [--profile <id>]
                        [--base-branch <branch>]

Runs the Implement phase against a GitHub Projects v2 item. Writes an
implementation on the ticket branch and opens/updates a PR.

Exit codes:
  0  pr_opened
  1  unexpected error
  2  needs_input (quality gates failed)
  64 usage error
`;

function makeFs(): ImplementFs {
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
          else
            out.push({
              path: path.posix.join(specPath, r),
              content: await readFile(full, "utf8"),
            });
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

function defaultQualityGates(): QualityGate[] {
  return [
    { name: "typecheck", command: ["npm", "run", "typecheck"] },
    { name: "lint", command: ["npm", "run", "lint:boundaries"], optional: true },
    { name: "test", command: ["npm", "test"] },
  ];
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        item: { type: "string" },
        change: { type: "string" },
        config: { type: "string" },
        "repo-root": { type: "string" },
        "run-id": { type: "string" },
        profile: { type: "string" },
        "base-branch": { type: "string" },
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
  const itemId = args.values.item;
  const changeName = args.values.change;
  if (!itemId || !changeName) {
    process.stderr.write(`missing --item or --change\n\n${USAGE}`);
    return 64;
  }
  const repoRoot = args.values["repo-root"] ?? process.cwd();
  const runId = args.values["run-id"] ?? `implement-${Date.now()}`;
  const profileId = args.values.profile ?? "default";
  const baseBranch = args.values["base-branch"] ?? "main";

  try {
    const config = await loadConfig({
      ...(args.values.config !== undefined ? { explicitPath: args.values.config } : {}),
      cwd: repoRoot,
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
    const gitInstance = simpleGit(repoRoot);
    const git = createSimpleGitOps({ repoRoot, git: gitInstance });
    const worktree = createSimpleGitWorktreeOps({
      repoRoot,
      git: gitInstance,
    });
    const gateRunner = createNodeQualityGateRunner();
    const implRole = config.roles.implementer;
    if (!implRole) {
      process.stderr.write(
        "config.roles.implementer must be defined\n",
      );
      return 1;
    }
    const makeAdapter = (provider: string): AgentAdapter =>
      provider === "claude-agent" ? new ClaudeAgentAdapter() : new CodexAdapter();
    const adapter = makeAdapter(implRole.provider);

    const result = await runImplementPhase(
      {
        github,
        git,
        gitForRepo: (scopedRepoRoot: string) =>
          createSimpleGitOps({ repoRoot: scopedRepoRoot, git: simpleGit(scopedRepoRoot) }),
        fs: makeFs(),
        worktree,
        gateRunner,
        agent: adapter,
        runId,
        profileId,
        implementerModel: implRole.model,
        qualityGates: defaultQualityGates(),
        baseBranch,
      },
      { itemId, changeName },
    );

    if (result.status === "pr_opened" && result.result) {
      process.stdout.write(
        `Implement phase: pr_opened\nPR: ${result.result.pr.url}\n`,
      );
      return 0;
    }
    process.stdout.write(`Implement phase: ${result.status}\n`);
    return 2;
  } catch (err) {
    const isPhase = err instanceof ImplementPhaseError;
    const wt = isPhase ? (err as ImplementPhaseError).worktreePath : undefined;
    process.stderr.write(
      `${isPhase ? `ImplementPhaseError (${(err as ImplementPhaseError).code}): ` : "Error: "}` +
        `${(err as Error).message}\n` +
        (wt ? `worktree: ${wt}\n` : ""),
    );
    return 1;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /implement\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
