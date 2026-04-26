import { main as createTicketMain } from "./create-ticket.js";
import { main as implementMain } from "./implement.js";
import { main as initMain } from "./init.js";
import { main as pickupMain } from "./pickup.js";
import { main as reviewMain } from "./review.js";
import { main as specifyMain } from "./specify.js";
import { main as startMain } from "./start.js";
import { main as workerMain } from "./worker.js";

const USAGE = `night-shift

Usage:
  night-shift <command> [options]

Commands:
  init
  worker
  start
  pickup
  specify
  implement
  review
  create-ticket

Run 'night-shift <command> --help' for command-specific usage.
`;

const COMMANDS = {
  init: initMain,
  worker: workerMain,
  start: startMain,
  pickup: pickupMain,
  specify: specifyMain,
  implement: implementMain,
  review: reviewMain,
  "create-ticket": createTicketMain,
} as const;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const handler = COMMANDS[command as keyof typeof COMMANDS];
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 64;
  }

  return handler(rest, env);
}

const entry = process.argv[1] ?? "";
const isMain = /night-shift\.(ts|js)$/.test(entry);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}