# Task 1 Review — Normalize the board model and lock in regression guardrails

## Review Scope

Verified the previous review's should-fix finding on branch `feat/temporal-simplest-workflow`, then inspected all Task 1–scoped source files against the authoritative artifact. Ran `make check` (57 orchestrator tests, 20 e2e tests, lint, and build — all green).

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-1.md` — Task 1: Normalize the board model and lock in regression guardrails.

## Acceptance / Spec Coverage

All four acceptance criteria remain satisfied. No regressions introduced since the previous review.

| AC | Status | Evidence |
|----|--------|----------|
| AC1: Idempotent verify/create of all 8 canonical statuses | ✅ Met | `ensureCanonicalProjectStatusOptions` in `activity-github-project.ts`; unit test "creates missing canonical project status options before selecting the Ready issue". |
| AC2: Shared blocked-reason / board-status / signal mapping as executable test data | ✅ Met | `BLOCKED_REASON_BOARD_SIGNAL_RULES` in `shared.ts`; `shared.test.ts` freezes the table. |
| AC3: Existing Ready workflow behavior green after status-model change | ✅ Met | All workflow success/failure tests pass (57 tests). |
| AC4: Fake-agent E2E assertions tolerate richer board lifecycle | ✅ Met | `assertObservedStatusSequence` validates canonical statuses; E2E test "accepts richer donor-compatible board lifecycles" passes. |

**DoD checklist:** All items green. `make check` passes. No manual bootstrap step needed.

## Previous Review Verification

The single should-fix from review `20260427T221936203486Z` has been **fixed**:

- **`blockedOptionId` contract tightening** — `SelectedProjectIssue.blockedOptionId` is now typed as `string` (non-optional). `getTopReadyIssueActivity` uses `getRequiredStatusOption` for Blocked (line 228 of `activity-github-project.ts`). `resolveFailureStatusOptionId` returns `string` directly without fallback logic (line 116–118 of `workflows.ts`).

## Findings

### Must Fix

(none)

### Should Fix

(none)

## Out-of-Scope Follow-Ups

- Previously captured in `tech-debt.md` and still applicable: `ensureProjectStatusOptions` not yet wired as an independent workflow step.
- Previously captured in `tech-debt.md` and still applicable: `BLOCKED_REASON_BOARD_SIGNAL_RULES` not yet consumed by runtime code.

No new out-of-scope items identified.

## Rejected Noise

(none — no new noise candidates in this verification pass)

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 1
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Task 1 is complete with no remaining findings. Proceed to Task 2.
