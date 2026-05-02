# Review — Task 9 final policy semantics (20260428T223847929354Z)

## Review Scope

Reviewed the full committed state of `feat/temporal-simplest-workflow` (16 commits ahead of `main`, HEAD at `96609d3`). Focus areas per requested scope: steady-state cleanup policy, corrupt/stale worktree recovery, retry-safe non-force push behavior, README/Makefile/test-harness follow-ups, and live-proof alignment. Inspected `activity-worktree.ts`, `workflows.ts`, `shared.ts`, `Makefile`, `README.md`, `orchestrator/README.md`, `e2e/src/live-github.ts`, `e2e/src/live-github.test.ts`, all three phase error classes, workflow test helpers, `workflow-success.test.ts`, `workflow-failure.test.ts`, `activity-worktree.test.ts`, and `tech-debt.md`. Verified `make check` passes (lint + tests + build all green).

## Source Artifact

No authoritative artifact was supplied. The task plan at `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-9.md` was used as a reference for scope alignment.

## Acceptance / Spec Coverage

Skipped — no authoritative artifact was supplied. Against the task-9 plan's acceptance criteria:
- AC1 (push policy): `buildPushArgs` uses `git push -u origin <branch>` (no force); `commitAndPush` handles retry replay where `origin/<branch>` already equals HEAD. Covered by 4 targeted tests in `activity-worktree.test.ts`.
- AC2 (cleanup/preservation): `cleanupSuccessfulWorktree` wired on success path; failure paths do not call cleanup; tested in `workflow-success.test.ts` and `workflow-failure.test.ts` (asserts `cleanupCalls === 0`).
- AC3 (migration shims): intentional seams documented in `orchestrator/README.md`.
- AC4 (live E2E): live fake-agent evidence recorded in task-9 review artifact.

## Previous Review Verification

Previous review verification was skipped — no previous review was supplied as input to this run.

The most recent prior review (20260428T215005079647Z) identified one should-fix: missing trailing newline in `orchestrator/src/mocha/workflow-success.test.ts`. This finding **remains unfixed** — the file still ends without a trailing newline (verified via hex inspection).

## Findings

### Must Fix

_(none)_

### Should Fix

- **Missing trailing newline in `workflow-success.test.ts`** (carried forward from prior review 20260428T215005079647Z): File `orchestrator/src/mocha/workflow-success.test.ts` ends with `}` and no trailing newline. POSIX convention and most linters expect a trailing newline. Add `\n` after the final `}`.

### Observations (informational, no action required)

- `buildPhaseFailureComment` (workflows.ts:434) suggests `readyStatusName` for both implement and review phase failures. For review failures where a PR already exists, `inReviewStatusName` would be more precise. Already tracked in tech-debt.
- `ReviewPhaseContractError` and `ImplementPhaseContractError` manually assign `cause` instead of using `super(message, { cause })`. `SpecifyPhaseContractError` discards cause entirely. All three are already tracked in tech-debt.
- `cleanupLocalWorktree` on success path does not pass `tolerateCorruptState`, so a stale worktree registration at cleanup time will throw (caught and logged by `cleanupSuccessfulWorktree`). Acceptable behavior; already noted in prior review.

## Out-of-Scope Follow-Ups

All legitimate follow-ups are already captured in `.ai/tech-debt.md`. No new items to append.

## Rejected Noise

- `buildPushArgs` extracted as a named function for documentation purposes: intentional, fine.
- `withDefaultWorkflowActivities` providing a no-op `cleanupWorktree` default: correct pattern for backward-compatible test helpers.
- `Makefile` `check` target order (`lint test build`): lint-first is fast-fail-friendly; `test-e2e` depends on `build-orchestrator`; no issue.
- `isHealthyIssueWorktree` only checks `rev-parse --show-toplevel`: already tracked as low-priority tech debt.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact supplied
- Verification Attempted: true (informal — checked prior review's single finding)
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 1
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add a trailing newline to `orchestrator/src/mocha/workflow-success.test.ts`.
2. Commit and land the Task 9 changes (or the full branch).
