import { parseArgs } from "node:util";
import { deriveChangeName } from "../contracts/helpers.js";
import { loadConfig } from "../config/loader.js";
import { createGitHubClient } from "../github/factory.js";
import { StatusNameSchema } from "../github/types.js";

const USAGE = `night-shift create-ticket

Usage:
  night-shift create-ticket --title <title>
                           [--body <body>]
                           [--label <label> ...]
                           [--status <status>]
                           [--config <path>]
                           [--json]

Creates a GitHub issue, adds it to the configured project board, sets the
requested status, and prints the derived change name and workflow start command.

Exit codes:
  0  ticket created
  1  unexpected error
  64 usage error
`;

function formatOutput(ticket: {
  itemId: string;
  issueNumber: number;
  issueUrl: string;
  status: string;
  changeName: string;
  startCommand: string;
}) {
  return [
    `Created workflow test ticket #${ticket.issueNumber}`,
    `Item: ${ticket.itemId}`,
    `Status: ${ticket.status}`,
    `Issue: ${ticket.issueUrl}`,
    `Derived change: ${ticket.changeName}`,
    `Start command: ${ticket.startCommand}`,
  ].join("\n");
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
        title: { type: "string" },
        body: { type: "string" },
        label: { type: "string", multiple: true },
        status: { type: "string" },
        config: { type: "string" },
        json: { type: "boolean" },
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

  const title = args.values.title;
  if (!title) {
    process.stderr.write(`missing --title\n\n${USAGE}`);
    return 64;
  }

  const statusValue = args.values.status ?? "Backlog";
  const parsedStatus = StatusNameSchema.safeParse(statusValue);
  if (!parsedStatus.success) {
    process.stderr.write(`invalid --status value: ${statusValue}\n\n${USAGE}`);
    return 64;
  }

  try {
    const config = await loadConfig({
      ...(args.values.config !== undefined
        ? { explicitPath: args.values.config }
        : {}),
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
    const created = await github.createProjectTicket({
      title,
      ...(args.values.body !== undefined ? { body: args.values.body } : {}),
      ...(args.values.label && args.values.label.length > 0
        ? { labels: args.values.label }
        : {}),
      status: parsedStatus.data,
    });

    const changeName = deriveChangeName(created.title, created.issueNumber);
    const result = {
      ...created,
      changeName,
      startCommand: `npm run start -- ${created.itemId} --change ${changeName}`,
    };

    process.stdout.write(
      args.values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatOutput(result)}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ?? "";
const isMain = /create-ticket\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}