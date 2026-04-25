import { parseArgs } from "node:util";
import path from "node:path";
import { simpleGit } from "simple-git";
import { loadConfig } from "../config/loader.js";
import { CodexAdapter, ClaudeAgentAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/events.js";
import { createGitHubClient } from "../github/factory.js";
import { createSimpleGitOps } from "../git/index.js";
import { createOpenSpecCli } from "../phases/specify/openspec-cli.js";
import { runSpecifyPhase, type SpecifyFs } from "../phases/specify/phase.js";
import { SpecifyPhaseError } from "../phases/specify/errors.js";
import { readdir, readFile, stat } from "node:fs/promises";

const USAGE = `night-shift specify

Usage:
  night-shift specify --item <projectItemId> --change <change-name>
                      [--config <path>]
                      [--base-branch <branch>]
                      [--run-id <id>] [--profile <id>]

Runs the Specify phase against a GitHub Projects v2 item. Produces an
OpenSpec change folder on the ticket branch and opens/updates a spec review PR.

Exit codes:
  0  refined
  1  unexpected error
  2  needs_input (validator failed or open questions)
  64 usage error
`;

function makeFs(repoRoot: string): SpecifyFs {
  return {
    async readPriorDraft(changeDir) {
      const base = path.join(repoRoot, changeDir);
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

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        item: { type: "string" },
        change: { type: "string" },
        config: { type: "string" },
        "base-branch": { type: "string" },
        "run-id": { type: "string" },
        profile: { type: "string" },
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
  const baseBranch = args.values["base-branch"] ?? "main";
  const runId = args.values["run-id"] ?? `specify-${Date.now()}`;
  const profileId = args.values.profile ?? "default";

  try {
    const config = await loadConfig({
      ...(args.values.config !== undefined ? { explicitPath: args.values.config } : {}),
    });
    const repoRoot = path.resolve(config.repoRoot ?? process.cwd());
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
    const git = createSimpleGitOps({ repoRoot, git: simpleGit(repoRoot) });
    const openspecCli = createOpenSpecCli();
    const roleConfig = config.roles.specifier;
    if (!roleConfig) {
      process.stderr.write("config.roles.specifier is not defined\n");
      return 1;
    }
    const adapter: AgentAdapter =
      roleConfig.provider === "claude-agent"
        ? new ClaudeAgentAdapter()
        : new CodexAdapter();

    const result = await runSpecifyPhase(
      {
        github,
        git,
        fs: makeFs(repoRoot),
        agent: adapter,
        openspecCli: {
          validate: (name, opts) => openspecCli.validate(name, { ...opts, cwd: repoRoot }),
        },
        baseBranch,
        runId,
        profileId,
        model: roleConfig.model,
        workingDirectory: repoRoot,
      },
      { itemId, changeName },
    );

    process.stdout.write(
      `Specify phase: ${result.status}\nbranch: ${result.bundle?.branch ?? "(not set)"}\n` +
        `openQuestions: ${result.openQuestions.length}\n`,
    );
    return result.status === "refined" ? 0 : 2;
  } catch (err) {
    const isPhase = err instanceof SpecifyPhaseError;
    process.stderr.write(
      `${isPhase ? `SpecifyPhaseError (${(err as SpecifyPhaseError).code}): ` : "Error: "}` +
        `${(err as Error).message}\n`,
    );
    return 1;
  }
}

// Allow direct execution via `tsx src/cli/specify.ts` or node on a built file.
const entry = process.argv[1] ?? "";
const isMain = /specify\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
