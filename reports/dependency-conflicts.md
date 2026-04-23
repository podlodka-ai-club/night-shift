# Dependency Conflict Report

**Date:** 2026-04-22  
**Repo:** feature-factory  
**Ecosystems detected:** Node / npm (`package.json`, `package-lock.json`)

---

## Summary

| Severity | Count |
|----------|-------|
| Peer-dependency conflict (install-blocking) | 1 |
| Duplicate transitive versions | 0 |
| Known vulnerabilities (`npm audit`) | 0 |

---

## Conflict 1 — `zod` peer dependency mismatch (BLOCKING)

### Description

`@anthropic-ai/claude-agent-sdk@0.2.117` declares a **hard peer dependency** on `zod@^4.0.0`.  
The root `package.json` currently pins `zod@^3.24.1` (resolved to `3.25.76` in the lockfile).

Running `npm install` (without `--legacy-peer-deps`) fails with:

```
npm error ERESOLVE could not resolve
npm error peer zod@"^4.0.0" from @anthropic-ai/claude-agent-sdk@0.2.117
npm error Conflicting peer dependency: zod@4.3.6
```

### Affected packages

| Package | Required zod range |
|---------|--------------------|
| `@anthropic-ai/claude-agent-sdk@0.2.117` | `^4.0.0` (**hard peer**) |
| `@anthropic-ai/sdk` (nested) | `^3.25.0 \|\| ^4.0.0` |
| `@modelcontextprotocol/sdk` | `^3.25 \|\| ^4.0` |
| `openai` | `^3.25 \|\| ^4.0` |
| `zod-to-json-schema` | `^3.25.28 \|\| ^4` |

All other packages already accept both v3 and v4, so upgrading to zod v4 is safe.

### Root cause

`zod` v3 → v4 was a major release. `@anthropic-ai/claude-agent-sdk` moved to zod v4 as its only accepted peer version. The root `package.json` was not updated when `@anthropic-ai/claude-agent-sdk` was upgraded.

### Fix applied

- Upgrade `zod` from `^3.24.1` → `^4.0.0` in `package.json` `dependencies`.
- Add `overrides` entry (`"zod": "^4.0.0"`) to ensure all transitive consumers resolve zod v4.
- Regenerate `package-lock.json` by running `npm install`.

### Zod v3 → v4 migration impact

The only file in this repo that imports zod is `src/config.ts`. Reviewed usages:
- `z.object`, `z.string`, `z.number`, `z.boolean`, `z.enum`, `z.coerce`, `z.infer` — all stable across v3→v4.
- No breaking changes apply to the schemas used in this project.

---

## Duplicate Transitive Versions

No duplicate transitive package versions detected in the current `package-lock.json`.

---

## Security Vulnerabilities

`npm audit` reports **0 vulnerabilities** (before and after fix).

---

## Recommended Actions

| # | Action | Status |
|---|--------|--------|
| 1 | Upgrade `zod` to `^4.0.0` in `package.json` | ✅ Applied |
| 2 | Add `overrides.zod = "^4.0.0"` to `package.json` | ✅ Applied |
| 3 | Regenerate `package-lock.json` with `npm install` | ✅ Applied |
| 4 | Verify `npm ci` succeeds in clean environment | ✅ CI step added |
| 5 | Enable Dependabot for ongoing dependency maintenance | ✅ Config added |

---

## No Other Ecosystems Detected

Scanned for: `yarn.lock`, `pnpm-lock.yaml`, `go.mod`, `requirements.txt`, `pyproject.toml`, `pom.xml`  
None found — only npm ecosystem applies.
