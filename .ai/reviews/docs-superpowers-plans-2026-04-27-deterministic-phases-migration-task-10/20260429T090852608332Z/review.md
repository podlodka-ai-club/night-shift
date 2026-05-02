# Review — Task 10 donor-compatible configuration loading (20260429T090852608332Z)

## Review Scope

Artifact-validated review of uncommitted working-tree changes on `feat/temporal-simplest-workflow` (HEAD `96609d3`, working tree dirty). Reviewed new files (`config.ts`, `entrypoint-config.ts`, `config.test.ts`, `entrypoint-config.test.ts`), diffs to `client.ts`, `worker.ts`, `README.md`, `activity-github-client.ts`, `activity-github-pull-request.ts`, `activity-github.test.ts`, and `workflow-success.test.ts`. TypeScript compilation passes; all new and modified tests pass (7 config/entrypoint tests, 19 activity tests).

The requested scope also includes "self-review fallback cleanup" which is implemented in `activity-github-pull-request.ts` / `activity-github-client.ts`.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-10.md` — donor-compatible configuration loading.

## Acceptance / Spec Coverage

| AC | Status | Notes |
|----|--------|-------|
| 1. Documented precedence: `--config` → env → discovered | ✅ | `resolveOrchestratorConfigPath` implements this; `parseEntrypointConfigArgs` extracts `--config`; README documents the order. |
| 2. Donor-compatible filename patterns | ✅ | `CONFIG_FILENAMES` includes both `orchestrator.config.*` and `night-shift.config.*` patterns. |
| 3. TS exports, `.env` loading, validation/defaulting | ✅ | `loadConfigModule` handles TS/JS/MJS; `loadAdjacentEnvFile` loads `.env`; Zod schema validates and defaults. |
| 4. Worker/client run from config without positional CLI args | ✅ | `loadClientEntrypointConfig` falls through to `config.github.projectOwner`/`projectNumber`; `loadWorkerEntrypointConfig` resolves Temporal settings from config. |
| 5. Env/CLI backward compatibility with documented precedence | ✅ | CLI positional args > env vars > config values; README documents the order. |
| 6. E2E exception documented | ✅ | README explicitly states E2E remains a deliberate temporary exception. |
| 7. Tests cover precedence, donor filenames, `.env`, validation, backward compat | ✅ | `config.test.ts` (3 tests) + `entrypoint-config.test.ts` (4 tests) cover all listed scenarios. |

DoD items: targeted unit tests ✅, entry-point wiring tests ✅, `tsc --noEmit` passes ✅, sample config + precedence docs in README ✅. Fake-agent verification path exercising config-file-driven flow not yet verified (see Should Fix).

## Previous Review Verification

The supplied previous review (`20260428T224857699796Z`) covers Task 9, not Task 10. It reported zero actionable findings. Verification is not applicable to the current task scope.

## Findings

### Must Fix

_(none)_

### Should Fix

- **`pathToFileUrl` uses string interpolation instead of `url.pathToFileURL`** (`config.ts:113-115`): `new URL(\`file://${filePath}\`)` breaks on paths containing spaces, `#`, `%`, or other URL-special characters. Use `import { pathToFileURL } from 'node:url'` and call `pathToFileURL(filePath).href` instead.

- **Client/worker Temporal address precedence asymmetry** (`client.ts:60-65` vs `worker.ts:8-9`): `worker.ts` applies config-file Temporal settings directly, while `client.ts` layers `shouldUseEntrypointTemporalAddress`/`shouldUseEntrypointTemporalNamespace` guards that only apply config values when the SDK envconfig resolves to localhost defaults. This creates silently different precedence behavior between the two entrypoints for the same config file. Either document the asymmetry explicitly or unify the approach.

- **`resolveTemporalEntrypointConfig` uses verbose return-type annotation** (`entrypoint-config.ts:118`): `Awaited<ReturnType<typeof loadOrchestratorConfig>>` should be replaced with the exported `OrchestratorConfig` type for readability.

- **Missing `NIGHT_SHIFT_CONFIG` env-override test** (`config.test.ts`): The precedence test covers `ORCHESTRATOR_CONFIG` but does not verify that `NIGHT_SHIFT_CONFIG` is also respected as a fallback env override (AC1 lists env override as a separate precedence level).

- **No fake-agent config-file-driven verification path** (DoD): The DoD requires "at least one fake-agent verification path exercises the config-file-driven entrypoint flow end to end." No E2E or fake-agent test currently exercises the config-file path. Consider adding a minimal test or documenting why this is deferred.

## Out-of-Scope Follow-Ups

- E2E config migration: `e2e/src/config.ts` still uses its own `E2E_*` env-var contract. Migrate to the shared config loader in a future task.
- `client.ts` top-level error handler still does not unwind the `.cause` chain (already tracked in tech-debt from Task 8 final review).
- Self-review fallback: the `isPullRequestSelfReviewError` non-retryable wrapping is wired in the activity but no workflow-level degradation path consumes the `GitHubSelfReviewNotAllowed` type to skip the approval step gracefully. This should be wired in a follow-up.

## Rejected Noise

- `workflow-success.test.ts` trailing whitespace diff: cosmetic, no functional change.
- `NOTES.md` diff: not inspected; out of scope for code review.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Replace `pathToFileUrl` with `pathToFileURL` from `node:url`.
2. Unify or document the client/worker Temporal address precedence asymmetry.
3. Add a `NIGHT_SHIFT_CONFIG` env-override unit test.
4. Simplify the `resolveTemporalEntrypointConfig` type annotation.
5. Add a minimal fake-agent config-file-driven verification test or document the deferral.
6. Commit the working-tree changes once the should-fix items are addressed.
