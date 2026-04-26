import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveSelectedRepoRoot } from "./shared.js";

const USAGE = `night-shift init

Usage:
  night-shift init [--repo-root <path>] [--force]

Scaffolds a repo-local night-shift.config.ts that reads secrets from
environment variables, seeds OpenSpec role skills, and bootstraps a minimal
OpenSpec layout when missing.

Exit codes:
  0  config written
  1  unexpected error
  64 usage error
`;

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        "repo-root": { type: "string" },
        force: { type: "boolean" },
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

  const repoRoot = resolveSelectedRepoRoot(args.values["repo-root"]);
  const configPath = path.join(repoRoot, "night-shift.config.ts");

  try {
    await mkdir(repoRoot, { recursive: true });

    const createdOpenSpecPaths = await ensureOpenSpecScaffold(repoRoot);

    if (existsSync(configPath) && !args.values.force) {
      if (createdOpenSpecPaths.length === 0) {
        process.stderr.write(
          `night-shift init: ${configPath} already exists. Re-run with --force to overwrite.\n`,
        );
        return 1;
      }

      process.stderr.write(
        `night-shift init: ${configPath} already exists. Keeping it and scaffolding missing OpenSpec files.\n`,
      );
      for (const createdPath of createdOpenSpecPaths) {
        process.stdout.write(`Created ${createdPath}\n`);
      }
      return 0;
    }

    await writeFile(configPath, renderInitTemplate(), "utf8");
    process.stdout.write(`Created ${configPath}\n`);
    for (const createdPath of createdOpenSpecPaths) {
      process.stdout.write(`Created ${createdPath}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

function renderInitTemplate(): string {
  return `${renderConfigImportLine()}

export default defineNightShiftConfig({
  roles: {
    specifier: {
      provider: "codex",
      model: "gpt-5.4",
      skills: ["openspec-propose", "openspec-explore"],
    },
    implementer: {
      provider: "codex",
      model: "gpt-5.4",
      skills: ["openspec-apply-change", "openspec-explore"],
    },
    reviewer: {
      provider: "codex",
      model: "gpt-5.4-mini",
      skills: ["openspec-explore"],
    },
    subagent: {
      provider: "codex",
      model: "gpt-5.4-mini",
      skills: ["openspec-explore"],
    },
  },

  // Local setup: put these values in .env next to this config file.
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_REPO_OWNER ?? "your-username",
    repo: process.env.GITHUB_REPO_NAME ?? "your-repo",
    projectOwner: process.env.GITHUB_PROJECT_OWNER ?? "your-username-or-org",
    projectOwnerType: (process.env.GITHUB_PROJECT_OWNER_TYPE as "user" | "org") ?? "user",
    projectNumber: Number(process.env.GITHUB_PROJECT_NUMBER ?? "1"),
    // Or use GitHub App auth instead of a PAT:
    // appId: Number(process.env.GITHUB_APP_ID),
    // installationId: Number(process.env.GITHUB_INSTALLATION_ID),
    // privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH,
  },

  qualityGates: {
    typecheck: true,
    lint: true,
    test: true,
  },

  temporal: {
    serverUrl: "localhost:7233",
    namespace: "default",
    taskQueue: "night-shift",
  },

  // Example custom adapter registration:
  // adapterFactories: {
  //   copilot: ({ adapterConfig }) => createCopilotAdapter(adapterConfig),
  // },
  // adapters: {
  //   copilot: { mode: "workspace-write" },
  // },
});
`;
}

async function ensureOpenSpecScaffold(repoRoot: string): Promise<string[]> {
  const createdPaths: string[] = [];
  const specsDir = path.join(repoRoot, "openspec", "specs");
  const changesDir = path.join(repoRoot, "openspec", "changes");
  const projectPath = path.join(repoRoot, "openspec", "project.md");

  if (!existsSync(specsDir)) {
    await mkdir(specsDir, { recursive: true });
    createdPaths.push(specsDir);
  }

  if (!existsSync(changesDir)) {
    await mkdir(changesDir, { recursive: true });
    createdPaths.push(changesDir);
  }

  if (!existsSync(projectPath)) {
    await writeFile(projectPath, renderOpenSpecProjectTemplate(), "utf8");
    createdPaths.push(projectPath);
  }

  return createdPaths;
}

function renderOpenSpecProjectTemplate(): string {
  return `# Project

Bootstrapped by \`night-shift init\`.
`;
}

function renderConfigImportLine(): string {
  return ['import { defineNightShiftConfig } from "', 'night-shift/config', '";'].join("");
}

const entry = process.argv[1] ?? "";
const isMain = /init\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}