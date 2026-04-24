#!/usr/bin/env node
// Guardrail: src/contracts/** may import only from `zod` or sibling files.
// Catches accidental coupling to Temporal, Octokit, fs, etc.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const CONTRACTS_DIR = join(ROOT, "src", "contracts");
const ALLOWED_EXTERNAL = new Set(["zod"]);

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

const violations = [];
for (const file of walk(CONTRACTS_DIR)) {
  const src = readFileSync(file, "utf8");
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec.startsWith(".")) continue; // relative sibling
    if (ALLOWED_EXTERNAL.has(spec)) continue;
    // allow "zod/foo" subpaths just in case
    if ([...ALLOWED_EXTERNAL].some((p) => spec === p || spec.startsWith(`${p}/`))) continue;
    violations.push(`${relative(ROOT, file)}: disallowed import "${spec}"`);
  }
}

if (violations.length > 0) {
  console.error("Contracts module import violations:");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}
console.log("OK: src/contracts/** imports only zod and siblings.");
