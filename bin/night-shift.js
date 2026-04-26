#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const cliEntrypoint = fileURLToPath(new URL("../src/cli/night-shift.ts", import.meta.url));
const tsxLoaderPath = require.resolve("tsx");

const child = spawn(
	process.execPath,
	["--import", pathToFileURL(tsxLoaderPath).href, cliEntrypoint, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: process.env,
	},
);

const { code, signal } = await new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("exit", (exitCode, exitSignal) => {
		resolve({ code: exitCode, signal: exitSignal });
	});
});

if (signal) {
	process.kill(process.pid, signal);
}

process.exit(code ?? 1);