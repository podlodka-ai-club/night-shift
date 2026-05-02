# Task 1 Review — Normalize the board model and lock in regression guardrails

## Review Scope

Reviewed all changed files on `feat/temporal-simplest-workflow` compared to `main`, focusing on Task 1 scope: canonical GitHub Project status normalization, the shared blocked-reason/board-status/signal contract, preservation of current Ready-to-PR behavior, and E2E seeding/contract changes. The authoritative artifact `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-1.md` was used to validate acceptance criteria.

`make check` was executed and passed (58 orchestrator tests, 20 e2e tests, both workspaces build cleanly).

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-1.md` — Task 1: Normalize the board model and lock in regression guardrails.

## Acceptance / Spec Coverage

| AC | Status | Evidence |
|----|--------|----------|
| AC1: Idempotent verify/create of all 8 canonical statuses | ✅ Met | `ensureCanonicalProjectStatusOptions` in `activity-github-project.ts` computes missing statuses and issues `updateProjectV2Field` mutation. Covered by unit test "creates missing canonical project status options before selecting the Ready issue" in `activity-github.test.ts`. |
| AC2: Shared blocked-reason / board-status / signal mapping as executable test data | ✅ Met | `BLOCKED_REASON_BOARD_SIGNAL_RULES` in `shared.ts` is a `const satisfies` table with typed constraints. `shared.test.ts` freezes the exact table content. The table is structured as reusable test data for later workflow/trigger tests. |
| AC3: Existing Ready workflow behavior green after status-model change | ✅ Met | `automateTopReadyIssue` workflow, worktree, PR, checkpoint, and failure tests all pass. `READY_ISSUE_STATUS_SEQUENCE` is preserved and tested. |
| AC4: Fake-agent E2E assertions tolerate richer board lifecycle | ✅ Met | `run-contract.ts` `assertObservedStatusSequence` validates all observed statuses are canonical and requires the `Ready → In progress → In review` subsequence. E2E test "accepts richer donor-compatible board lifecycles" proves `[Backlog, Refinement, Refined, Ready, In progress, In review, Ready to merge]` passes. |

**DoD checklist:**
- Unit tests for status-option lookup/creation: ✅
- Table-driven tests proving the transition contract: ✅
- Existing worktree/GitHub/workflow/checkpoint tests pass: ✅ (58 passing)
- `make check` passes: ✅
- E2E harness passes in fake-agent mode (offline tests): ✅ (20 passing)
- Manual/bootstrap command documented: N/A — status creation is automatic via `ensureCanonicalProjectStatusOptions`.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

(none)

### Should Fix

- **`blockedOptionId` is optional in `SelectedProjectIssue` but guaranteed after `ensureCanonicalProjectStatusOptions`.** `getTopReadyIssueActivity` calls `findStatusOption` (which returns `undefined`) for `Blocked` instead of `getRequiredStatusOption`, making `blockedOptionId` optional (`string | undefined`). Since the same function already calls `ensureCanonicalProjectStatusOptions` which guarantees all 8 statuses exist, `Blocked` will always be present. Using `getRequiredStatusOption` and making `blockedOptionId` non-optional (`string`) would eliminate downstream `?? readyOptionId` fallback logic in `resolveFailureStatusOptionId` and simplify the contract for later phases that depend on `Blocked` being present. (`activity-github-project.ts:228`, `shared.ts:79`, `workflows.ts:117`)

## Out-of-Scope Follow-Ups

- The `ensureProjectStatusOptions` activity is exported and registered but not yet called from the workflow itself — only from `getTopReadyIssue` and the E2E seeding path. Later tasks should wire it into the workflow entry point or pickup flow so that status normalization is an explicit, independently retriable step.
- `BLOCKED_REASON_BOARD_SIGNAL_RULES` is defined and frozen, but no runtime code consumes it yet. Task 2+ should wire the table into webhook/signal dispatch logic.

## Rejected Noise

- Test helper default status options include all 8 canonical statuses rather than only the 3 the current workflow uses: this is intentional forward-looking design aligned with Task 1 scope, not dead code.
- `CANONICAL_PROJECT_STATUS_NAMES` ordering matches the donor branch's board column order rather than alphabetical: this is correct and intentional.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Consider tightening `blockedOptionId` to non-optional in `SelectedProjectIssue` since `ensureCanonicalProjectStatusOptions` guarantees it (should-fix above).
2. Proceed to Task 2 — the shared contract table and status normalization seam are ready for consumption by workflow signal/trigger logic.
