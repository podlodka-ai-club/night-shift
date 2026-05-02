# Review — Task 10 donor-compatible configuration loading (20260429T092630111845Z)

## Review Scope

Verification-first review of uncommitted working-tree changes on `feat/temporal-simplest-workflow` (HEAD `96609d3`, working tree dirty). Verified the 5 should-fix findings from the previous review (`20260429T090852608332Z`), then performed a fresh artifact-validated pass over the same file set: new files (`config.ts`, `entrypoint-config.ts`, `config.test.ts`, `entrypoint-config.test.ts`), diffs to `client.ts`, `worker.ts`, `README.md`, `activity-github-client.ts`, `activity-github-pull-request.ts`, `activity-github.test.ts`, and `workflow-success.test.ts`. TypeScript compilation passes (`tsc --noEmit` clean); all 10 config/entrypoint tests pass.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-10.md` — donor-compatible configuration loading.

## Acceptance / Spec Coverage

| AC | Status | Notes |
|----|--------|-------|
| 1. Documented precedence: `--config` → env → discovered | ✅ | `resolveOrchestratorConfigPath` implements this; `parseEntrypointConfigArgs` extracts `--config`; README documents the order. |
| 2. Donor-compatible filename patterns | ✅ | `CONFIG_FILENAMES` includes both `orchestrator.config.*` and `night-shift.config.*` patterns. |
| 3. TS exports, `.env` loading, validation/defaulting | ✅ | `loadConfigModule` handles TS/JS/MJS; `loadAdjacentEnvFile` loads `.env`; Zod schema validates and defaults. |
| 4. Worker/client run from config without positional CLI args | ✅ | Both entrypoints use `loadClientEntrypointConfig`/`loadWorkerEntrypointConfig` from the shared config layer. |
| 5. Env/CLI backward compatibility with documented precedence | ✅ | CLI positional args > env vars > config values; README documents the order; test at `entrypoint-config.test.ts:134-182` proves it. |
| 6. E2E exception documented | ✅ | README:159 explicitly states E2E remains a deliberate temporary exception. |
| 7. Tests cover precedence, donor filenames, `.env`, validation, backward compat | ✅ | `config.test.ts` (5 tests) + `entrypoint-config.test.ts` (5 tests) cover all listed scenarios including NIGHT_SHIFT_CONFIG and URL-escaping. |

DoD items: targeted unit tests ✅, entry-point wiring tests ✅, `tsc --noEmit` passes ✅, sample config + precedence docs in README ✅, fake-agent deferral documented in README ✅.

## Previous Review Verification

Previous review: `20260429T090852608332Z` (5 should-fix findings, 0 must-fix).

| # | Finding | Status |
|---|---------|--------|
| 1 | `pathToFileUrl` uses string interpolation instead of `url.pathToFileURL` | **Fixed**: `config.ts:4` imports `pathToFileURL` from `node:url`; `config.ts:114-116` uses `pathToFileURL(filePath).href`. New test at `config.test.ts:89-102` covers URL-special characters. |
| 2 | Client/worker Temporal address precedence asymmetry | **Fixed**: Both entrypoints now share `resolveTemporalEntrypointConfig` (`entrypoint-config.ts:118-124`). Old `shouldUseEntrypointTemporalAddress`/`shouldUseEntrypointTemporalNamespace` guards removed. Test at `entrypoint-config.test.ts:95-132` proves symmetric precedence. |
| 3 | `resolveTemporalEntrypointConfig` verbose return-type annotation | **Fixed**: Uses `ResolvedTemporalEntrypointConfig` interface (lines 8-12) instead of `Awaited<ReturnType<...>>`. |
| 4 | Missing `NIGHT_SHIFT_CONFIG` env-override test | **Fixed**: `config.test.ts:31-53` adds dedicated test. |
| 5 | No fake-agent config-file-driven verification path | **Fixed (documented deferral)**: README:159 documents E2E deferral, satisfying the DoD's "or document the deferral" clause. |

All 5 prior findings resolved. Proceeding with fresh review pass.

## Findings

### Must Fix

_(none)_

### Should Fix

_(none)_

## Out-of-Scope Follow-Ups

- E2E config migration: `e2e/src/config.ts` still uses its own `E2E_*` env-var contract. Already tracked in tech-debt.
- Self-review fallback workflow wiring: `isPullRequestSelfReviewError` wraps as `GitHubSelfReviewNotAllowed` but no workflow-level degradation path consumes this to skip the approval step. Already tracked in tech-debt.

## Rejected Noise

- `workflow-success.test.ts` trailing whitespace diff: cosmetic only.
- `NOTES.md` diff: out of scope for code review.
- `tsconfig.tsbuildinfo` diff: build artifact.

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 5
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Commit the working-tree changes — all prior findings are resolved, all ACs met, tests green, types clean.
2. Address the two already-tracked tech-debt items (E2E config migration, self-review workflow fallback) in future tasks.
