## Review Scope

Reviewed the local diff on branch `feat/temporal-simplest-workflow` against Task 5 acceptance criteria and definition of done from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-5.md`. This review was specifically requested after the `ImplementPhaseContractError` cause-preservation follow-up from the prior review (20260428T133031690060Z). All implement-phase source files (`orchestrator/src/phases/implement/`), the workflow shell (`workflows.ts`), shared types (`shared.ts`), activity wiring (`activities.ts`, `activity-worktree.ts`, `activity-agent-sequence.ts`, `agent-schema-registry.ts`), all related test files, and the E2E fake-agent harness were inspected. `make check` was rerun and confirmed green (97 orchestrator tests, 24 E2E tests, lint, tsc build).

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-5.md` — Task 5: Port the Implement phase on top of the current git and PR mechanics.

## Acceptance / Spec Coverage

All seven acceptance criteria remain satisfied after the follow-up fix:

| AC | Status | Evidence |
|----|--------|----------|
| AC1 — Ready → In progress, read spec, write files, commit with phase-owned commitMessage | ✅ | `runImplementPhase` moves to `inProgressOptionId`, reads spec bundle, writes files via `writeRepositoryFiles`, commits with `latestResponse.commitMessage` |
| AC2 — Gates pass → push, open/update PR, upsert `implement:summary`, move to In review | ✅ | `phase.ts` lines 100–117; `updateIfExists: true` on `openPullRequest` |
| AC3 — Gates fail after retry → upsert summary, move to Blocked, block on `implement_needs_input` | ✅ | Post-loop fallback `phase.ts` lines 126–135; workflow shell blocks on `condition(() => pendingImplementRetry)` |
| AC4 — Fail-once / retry-with-feedback / succeed-on-second-attempt | ✅ | `implement-phase.test.ts` "retries once after a gate failure" test; `ImplementRetryFeedback` typed and fed into prompt |
| AC5 — Existing retry-safe behaviors intact | ✅ | `workflow-success.test.ts` tests for PR-open retry, comment retry, status-update retry; commit failure tested in `workflow-failure.test.ts` |
| AC6 — `implementRetry` unblocks only the Implement gate | ✅ | `workflow-shell.test.ts` "blocks on implement_needs_input" test |
| AC7 — Legacy Ready without spec bundle → explicit rejection | ✅ | `implement-phase.test.ts` "returns needs_input with operator guidance when the approved spec bundle is missing" |

Definition of Done verified:
- Unit tests: contract parsing, file-path validation, quality-gate retry, prompt rendering. ✅
- Existing worktree/GitHub PR tests pass + new `pr_opened` vs `needs_input` phase tests. ✅
- Workflow tests: `implementRetry` gating, worktree reuse, partial-existing recovery. ✅
- Targeted retry-injection tests for dangerous side-effect windows (PR, comment, status). ✅
- Entry-validation tests for legacy Ready-without-spec-bundle. ✅
- `make check` passes from repository root. ✅
- E2E harness passes in fake-agent mode for a Ready-started ticket through PR creation. ✅

## Previous Review Verification

Previous review: 20260428T133031690060Z (Task 5 initial review).

| Finding | Status | Evidence |
|---------|--------|----------|
| `ImplementPhaseContractError` discards original cause (should-fix) | **Fixed** | `errors.ts` constructor now accepts `cause?: unknown` and assigns `this.cause = cause`; both throw sites in `phase.ts` (lines 161, 170) pass the original error as the second argument |

## Findings

### Must Fix

_(none)_

### Should Fix

_(none)_

## Out-of-Scope Follow-Ups

- Partial worktree recovery only checks directory existence — already captured in tech-debt.md (Task 5 section).
- Quality gate logs embedded verbatim in retry prompt — already captured in tech-debt.md (Task 5 section).

No new out-of-scope items identified. Tech-debt.md updated to mark the cause-preservation item as fixed.

## Rejected Noise

- `ImplementPhaseContractError` assigns `this.cause` manually rather than using `super(message, { cause })`. The project targets `lib: es2021` which does not include `Error.cause` in TypeScript's type definitions. Manual assignment is the correct pattern for this target and achieves the same runtime effect on Node 22.
- The `path.isAbsolute` call in `response.ts` was replaced with `value.startsWith('/') || /^[A-Za-z]:/.test(value)`. This removes the `node:path` import from the response module, making path validation platform-agnostic and safe for Temporal's deterministic sandbox.
- `findErrorInCauseChain` remains a local utility in `phase.ts`. Only the implement phase uses it; extracting it would be premature.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 1
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

No blocking or advisory findings remain. The cause-preservation follow-up is confirmed fixed. Proceed to Task 6.
