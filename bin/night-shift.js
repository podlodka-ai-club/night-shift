#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { register } = await import(require.resolve("tsx/esm/api"));

register({
	tsconfig: new URL("../tsconfig.json", import.meta.url).pathname,
});

const { main } = await import("../src/cli/night-shift.ts");

const code = await main(process.argv.slice(2));
process.exit(code);