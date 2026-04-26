import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveSelectedRepoRoot } from "./shared.js";

const DEFAULT_ROLE_SETUP = [
  {
    role: "specifier",
    provider: "codex",
    model: "gpt-5.4",
  },
  {
    role: "implementer",
    provider: "codex",
    model: "gpt-5.4",
  },
  {
    role: "reviewer",
    provider: "codex",
    model: "gpt-5.4-mini",
  },
  {
    role: "subagent",
    provider: "codex",
    model: "gpt-5.4-mini",
  },
] as const;

const USAGE = `night-shift init

Usage:
  night-shift init [--repo-root <path>] [--force]

Scaffolds a repo-local night-shift.config.ts that reads secrets from
environment variables for repo-local Night Shift usage.

Exit codes:
  0  config written
  1  unexpected error
  64 usage error
`;

const EXAMPLE_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../night-shift.config.example.ts",
);

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

    if (existsSync(configPath) && !args.values.force) {
      process.stderr.write(
        `night-shift init: ${configPath} already exists. Re-run with --force to overwrite.\n`,
      );
      return 1;
    }

    await writeFile(configPath, await renderInitTemplate(), "utf8");
    process.stdout.write(`Created ${configPath}\n`);
    process.stdout.write(`\n${renderOpenSpecSetupInstructions(repoRoot)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function renderInitTemplate(): Promise<string> {
  const exampleTemplate = await readFile(EXAMPLE_CONFIG_PATH, "utf8");

  return exampleTemplate
    .replace(/^\s+systemPromptFile: .*\n/gm, "")
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, "");
}

function renderOpenSpecSetupInstructions(repoRoot: string): string {
  const roleLines = DEFAULT_ROLE_SETUP.map(
    ({ role, provider, model }) =>
      `  - ${role}: provider=${provider}, model=${model}`,
  ).join("\n");

  return [
    "OpenSpec setup is not performed automatically.",
    "Install and initialize it explicitly before running the specifier:",
    `  cd ${repoRoot}`,
    "  npm install -g openspec",
    "  openspec init .",
    "",
    "Generated role defaults in night-shift.config.ts:",
    roleLines,
    "",
    "Agent-specific repo instructions should come from what is configured in the repository itself, not from Night Shift config.",
  ].join("\n");
}

const entry = process.argv[1] ?? "";
const isMain = /init\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}