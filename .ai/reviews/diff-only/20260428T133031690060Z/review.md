## Review Scope

Reviewed the local diff on branch `feat/temporal-simplest-workflow` against the acceptance criteria and definition of done in `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-5.md`. The review covered all implement-phase source files (`orchestrator/src/phases/implement/`), the workflow shell (`workflows.ts`), shared types (`shared.ts`), activity wiring (`activities.ts`), and all related test files (`implement-phase.test.ts`, `workflow-success.test.ts`, `workflow-failure.test.ts`, `workflow-shell.test.ts`, `phase-response-contracts.test.ts`). E2E fake-agent coverage was also inspected. `make check` and fake-agent E2E are reported green by the requester.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-5.md` — Task 5: Port the Implement phase on top of the current git and PR mechanics.

## Acceptance / Spec Coverage

All seven acceptance criteria are satisfied:

| AC | Status | Evidence |
|----|--------|----------|
| AC1 — Ready → In progress, read spec, write files, commit with phase-owned commitMessage | ✅ | `runImplementPhase` moves to `inProgressOptionId`, reads spec bundle, writes files, commits with `latestResponse.commitMessage` |
| AC2 — Gates pass → push, open/update PR, upsert `implement:summary`, move to In review | ✅ | Happy path in `phase.ts` lines 100–117; `updateIfExists: true` on `openPullRequest` |
| AC3 — Gates fail after retry → upsert summary, move to Blocked, block on `implement_needs_input` | ✅ | Post-loop fallback in `phase.ts` lines 126–135; workflow shell blocks on `condition(() => pendingImplementRetry)` |
| AC4 — Fail-once / retry-with-feedback / succeed-on-second-attempt | ✅ | `implement-phase.test.ts` "retries once after a gate failure" test; `ImplementRetryFeedback` typed and fed into prompt |
| AC5 — Existing retry-safe behaviors intact | ✅ | `workflow-success.test.ts` tests for PR-open retry, comment retry, status-update retry; commit failure tested in `workflow-failure.test.ts` |
| AC6 — `implementRetry` unblocks only the Implement gate | ✅ | `workflow-shell.test.ts` "blocks on implement_needs_input" test; `resumeSignal` is confirmed ignored while blocked |
| AC7 — Legacy Ready without spec bundle → explicit rejection | ✅ | `implement-phase.test.ts` "returns needs_input with operator guidance when the approved spec bundle is missing"; summary includes redirect to Specify |

Definition of Done coverage:

| DoD item | Status | Notes |
|----------|--------|-------|
| Unit tests: contract parsing, file-path validation, quality-gate retry, prompt rendering | ✅ | `phase-response-contracts.test.ts`, `implement-phase.test.ts` |
| Existing worktree/GitHub PR tests pass + new `pr_opened` vs `needs_input` tests | ✅ | `activity-worktree.test.ts` (403 lines), `activity-github.test.ts` (410 lines) unchanged; phase tests cover both outcomes |
| Workflow tests: `implementRetry` gating, worktree reuse, partial-existing recovery | ✅ | `workflow-shell.test.ts` covers gating and reuse; `activity-worktree.test.ts` covers path-exists short-circuit |
| Targeted retry-injection tests for dangerous side-effect windows | ✅ | `workflow-success.test.ts` covers PR, comment, and status side-effect retries |
| Entry-validation tests for legacy Ready-without-spec-bundle | ✅ | `implement-phase.test.ts` third test case |
| `make check` passes | ✅ | Reported green |
| E2E harness passes in fake-agent mode | ✅ | Reported green |

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

(none)

### Should Fix

- **`ImplementPhaseContractError` discards original cause**: In `phase.ts` lines 87 and 170, when wrapping errors into `ImplementPhaseContractError`, the original error is not preserved as `cause`. This loses stack context for debugging. Consider passing `{ cause: error }` as the second argument to the `Error` constructor inside `ImplementPhaseContractError`.

## Out-of-Scope Follow-Ups

- Partial worktree recovery only checks directory existence, not git state validity. A worktree left in a corrupted state (e.g., `git worktree add` interrupted mid-operation) will be returned as valid and produce cryptic downstream failures. Deferred to Task 9 cleanup-policy work.
- Quality gate logs are truncated to 4 KB but are embedded verbatim in the retry prompt via `buildRetryFailureMessage`. Very large logs could inflate prompt token usage. Consider a secondary truncation or summarization step when feeding logs into retry prompts.

## Rejected Noise

- The `hasApprovedSpecBundle` check hardcodes `proposal.md` and `tasks.md`. This is correct per the spec-bundle contract and does not need abstraction at this stage.
- `findErrorInCauseChain` is a local utility rather than a shared helper. The implement phase is the only consumer; extracting it would be premature.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Preserve original error cause in `ImplementPhaseContractError` construction (should-fix; one-line change in `phase.ts`).
2. Proceed to Task 6 (or the next planned task) — no blockers identified.
