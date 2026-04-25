import { execFileSync, spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const WORKER_ENTRY = "src/cli/worker.ts";
const POLL_INTERVAL_MS = 100;
const DEFAULT_GRACE_MS = 5000;

function printUsage() {
  process.stdout.write(`night-shift worker:restart-clean

Usage:
  npm run worker:restart-clean [-- [worker args...]]
  npm run worker:restart-clean -- --dry-run
  npm run worker:restart-clean -- --grace-ms 8000 --config path/to/config.ts

Options:
  --dry-run         Show what would be stopped and started without changing anything.
  --grace-ms <ms>   Wait this long after SIGINT before forcing SIGKILL. Default: 5000.
  -h, --help        Show this help.

Any remaining arguments are forwarded to src/cli/worker.ts.
`);
}

function parseArgs(argv) {
  let dryRun = false;
  let graceMs = DEFAULT_GRACE_MS;
  const workerArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, dryRun, graceMs, workerArgs };
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--grace-ms") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--grace-ms requires a value");
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`invalid --grace-ms value: ${next}`);
      }
      graceMs = parsed;
      index += 1;
      continue;
    }
    workerArgs.push(arg);
  }

  return { help: false, dryRun, graceMs, workerArgs };
}

function listWorkerProcesses() {
  const output = execFileSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter((proc) => proc.command.includes(WORKER_ENTRY));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}

async function stopWorkerProcess(proc, graceMs) {
  if (!isAlive(proc.pid)) {
    return;
  }

  process.stdout.write(`Stopping worker ${proc.pid}\n`);
  process.kill(proc.pid, "SIGINT");
  const exitedGracefully = await waitForExit(proc.pid, graceMs);
  if (exitedGracefully) {
    return;
  }

  process.stdout.write(`Force killing worker ${proc.pid} after ${graceMs}ms\n`);
  process.kill(proc.pid, "SIGKILL");
  const exitedAfterKill = await waitForExit(proc.pid, graceMs);
  if (!exitedAfterKill) {
    throw new Error(`worker ${proc.pid} did not exit after SIGKILL`);
  }
}

function formatCommand(workerArgs) {
  return [
    process.execPath,
    "--env-file-if-exists=.env",
    "--import",
    "tsx",
    WORKER_ENTRY,
    ...workerArgs,
  ].join(" ");
}

async function main() {
  const { help, dryRun, graceMs, workerArgs } = parseArgs(process.argv.slice(2));
  if (help) {
    printUsage();
    return;
  }

  const processes = listWorkerProcesses();
  if (processes.length === 0) {
    process.stdout.write("No existing worker processes found.\n");
  } else {
    for (const proc of processes) {
      process.stdout.write(`Found worker ${proc.pid}: ${proc.command}\n`);
    }
  }

  process.stdout.write(`Next worker command: ${formatCommand(workerArgs)}\n`);
  if (dryRun) {
    process.stdout.write("Dry run only; not stopping or starting anything.\n");
    return;
  }

  for (const proc of processes) {
    await stopWorkerProcess(proc, graceMs);
  }

  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "--import", "tsx", WORKER_ENTRY, ...workerArgs],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });

  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});