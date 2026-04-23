# npm audit — Before & After

**Date:** 2026-04-22  
**Branch:** `deps/fix/conflicts-001`

---

## Before (zod@^3.24.1, no overrides)

### Install attempt

```
npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error
npm error While resolving: @anthropic-ai/claude-agent-sdk@0.2.117
npm error Found: zod@3.25.76
npm error node_modules/zod
npm error   zod@"^3.24.1" from the root project
npm error
npm error Could not resolve dependency:
npm error peer zod@"^4.0.0" from @anthropic-ai/claude-agent-sdk@0.2.117
npm error
npm error Fix the upstream dependency conflict, or retry
npm error this command with --force or --legacy-peer-deps
```

### Audit (with --legacy-peer-deps workaround)

```
found 0 vulnerabilities
```

> Note: Install was only possible with `--legacy-peer-deps`, which masks the peer conflict.

---

## After (zod@^4.0.0, overrides applied)

### Install

```
changed 1 package, and audited 212 packages in 927ms
50 packages are looking for funding
found 0 vulnerabilities
```

### `npm ci` (clean install from lockfile)

```
added 211 packages, and audited 212 packages in 5s
50 packages are looking for funding
found 0 vulnerabilities
```

### `npm audit`

```
found 0 vulnerabilities
```

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| `npm install` succeeds (no flags) | ❌ ERESOLVE | ✅ |
| `npm ci` succeeds | ❌ | ✅ |
| Known vulnerabilities | 0 | 0 |
| zod version | 3.25.76 | 4.3.6 |
