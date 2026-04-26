#!/usr/bin/env -S node --import tsx

import { main } from "../src/cli/night-shift.ts";

const code = await main(process.argv.slice(2));
process.exit(code);