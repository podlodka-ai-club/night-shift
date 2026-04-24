#!/usr/bin/env node
// Guardrail: enforce per-module import boundaries.
//
// Rules (source of truth for both phase-contracts and agent-adapter-api specs):
//   src/contracts/** may import only: zod, and siblings within src/contracts/
//   src/adapters/**  may import only: zod, @openai/codex-sdk,
//                                      node:fs/promises, node:path,
//                                      src/contracts/**, and siblings within src/adapters/
//   src/config/**    may import only: zod, node:fs, node:path, node:url,
//                                      src/contracts/**, src/adapters/**,
//                                      and siblings within src/config/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SRC = join(ROOT, "src");

/** @type {Array<{name: string, dir: string, allowed: {externals: Set<string>, internal: string[]}}>} */
const MODULES = [
  {
    name: "contracts",
    dir: join(SRC, "contracts"),
    allowed: {
      externals: new Set(["zod"]),
      internal: ["src/contracts"],
    },
  },
  {
    name: "adapters",
    dir: join(SRC, "adapters"),
    allowed: {
      externals: new Set(["zod", "@openai/codex-sdk", "node:fs/promises", "node:path"]),
      internal: ["src/contracts", "src/adapters"],
    },
  },
  {
    name: "config",
    dir: join(SRC, "config"),
    allowed: {
      externals: new Set([
        "zod",
        "node:fs",
        "node:path",
        "node:url",
      ]),
      internal: ["src/contracts", "src/adapters", "src/config", "src/github"],
    },
  },
  {
    name: "github",
    dir: join(SRC, "github"),
    allowed: {
      externals: new Set([
        "zod",
        "@octokit/core",
        "@octokit/rest",
        "@octokit/graphql",
        "@octokit/webhooks",
        "@octokit/auth-app",
        "node:crypto",
        "node:fs/promises",
        "node:path",
        "node:timers/promises",
      ]),
      internal: ["src/contracts", "src/github"],
    },
  },
  {
    name: "git",
    dir: join(SRC, "git"),
    allowed: {
      externals: new Set([
        "zod",
        "simple-git",
        "node:fs/promises",
        "node:path",
        "node:os",
      ]),
      internal: ["src/contracts", "src/git"],
    },
  },
  {
    name: "phases",
    dir: join(SRC, "phases"),
    allowed: {
      externals: new Set([
        "zod",
        "zod-to-json-schema",
        "node:fs",
        "node:fs/promises",
        "node:path",
        "node:child_process",
        "node:timers/promises",
        "node:os",
        "node:util",
      ]),
      internal: [
        "src/contracts",
        "src/adapters",
        "src/github",
        "src/git",
        "src/config",
        "src/phases",
        "src/worktree",
        "src/quality-gates",
      ],
    },
  },
  {
    name: "worktree",
    dir: join(SRC, "worktree"),
    allowed: {
      externals: new Set([
        "zod",
        "simple-git",
        "node:fs",
        "node:fs/promises",
        "node:os",
        "node:path",
      ]),
      internal: ["src/contracts", "src/worktree"],
    },
  },
  {
    name: "quality-gates",
    dir: join(SRC, "quality-gates"),
    allowed: {
      externals: new Set([
        "zod",
        "node:child_process",
        "node:path",
        "node:timers/promises",
      ]),
      internal: ["src/contracts", "src/quality-gates"],
    },
  },
  {
    name: "cli",
    dir: join(SRC, "cli"),
    allowed: {
      externals: new Set([
        "zod",
        "simple-git",
        "node:fs",
        "node:fs/promises",
        "node:path",
        "node:process",
        "node:util",
      ]),
      internal: [
        "src/contracts",
        "src/adapters",
        "src/github",
        "src/git",
        "src/config",
        "src/phases",
        "src/worktree",
        "src/quality-gates",
        "src/cli",
      ],
    },
  },
];

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
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
// Pure `import type { ... } from "..."` declarations are erased at compile
// time and do not create a runtime dependency; we treat them as edge-free.
const TYPE_ONLY_IMPORT_RE = /^import\s+type\s+[^'"]*from\s+['"]([^'"]+)['"];?\s*$/gm;

let violations = [];
for (const mod of MODULES) {
  const files = walk(mod.dir);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const typeOnlySpecs = new Set();
    for (const match of src.matchAll(TYPE_ONLY_IMPORT_RE)) {
      typeOnlySpecs.add(match[1]);
    }
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith(".")) continue; // sibling relative import
      if (typeOnlySpecs.has(spec)) continue; // type-only, erased at runtime
      if (mod.allowed.externals.has(spec)) continue;
      if ([...mod.allowed.externals].some((p) => spec === p || spec.startsWith(`${p}/`))) continue;
      violations.push(
        `[${mod.name}] ${relative(ROOT, file)}: disallowed import "${spec}"`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Module boundary violations:");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}
console.log("OK: all module boundaries respected.");
