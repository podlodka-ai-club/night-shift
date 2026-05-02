# Review — Task 8 Deterministic Phases Migration (Final Verification)

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` at commit `6737176`, focusing on pickup/manual intake only (no webhook support). Inspected `intake.ts`, `activities.ts`, `client.ts`, `shared.ts`, `workflows.ts`, and their test files (`intake.test.ts`, `intake-workflow.test.ts`). Assumed `make check` and live fake-agent E2E are green per the review request. Reviewed only for remaining material findings after the documentation/clarity follow-ups in `intake.ts` and `activities.ts`.

## Source Artifact

Task 8 spec: `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`. No external story/ticket artifact was supplied.

## Acceptance / Spec Coverage

All seven acceptance criteria appear satisfied:

1. **AC1** — `Backlog` items with no workflow start are started in `specify` mode. Verified in `resolveWorkflowTriggerAction` (lines 97-98) and tested (intake.test.ts lines 17-24).
2. **AC2** — `Ready` items with no workflow start are started in `implement` mode. Same function (line 98) and tested (lines 25-32).
3. **AC3** — Intake decisions for `Backlog`, `Ready`, and `In review` signal blocked workflows per the transition contract (`BLOCKED_REASON_BOARD_SIGNAL_RULES`). All 6 rule combinations tested (intake.test.ts lines 33-56).
4. **AC4** — Pickup merges `Backlog` and `Ready`, sorts by `createdAt`, respects cap. Tested in "merges pickup backlog and ready items" and "caps pickup actions" tests.
5. **AC5** — Trigger-resolution tests cover start/signal/noop, mismatch, duplicate, and closed/restart. All exercised in intake.test.ts.
6. **AC6** — Idempotency proven at workflow level (intake-workflow.test.ts: signal-instead-of-duplicate, noop-on-mismatch). Unit-level race recovery tested via `WorkflowExecutionAlreadyStartedError` handler.
7. **AC7** — Webhook support is explicitly excluded per code, tests, and tech-debt documentation.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

_(none)_

### Should Fix

- **`buildManualCandidate` has no unit tests** (`intake.ts:59-68`). The function is exported and used in the production client path (`client.ts:47`), but neither `intake.test.ts` nor `intake-workflow.test.ts` exercises it directly. Its `startPhase: undefined` behavior for `In review` items is an important invariant that should be regression-tested. Add a small unit test verifying `Backlog` → `specify`, `Ready` → `implement`, `In review` → `undefined`.

- **No repeated-pickup-tick idempotency unit test**. AC6 asks for "repeated pickup ticks … observing the same item." The workflow-level test proves signal-vs-duplicate safety, and the `WorkflowExecutionAlreadyStartedError` race-recovery test proves the handler recovers. However, there is no unit test calling `runPickupIntake` twice with identical candidates to prove the second tick produces only noops/signals. This is a weak gap (the integration test covers it indirectly), but a targeted unit test would strengthen the AC6 proof.

## Out-of-Scope Follow-Ups

- Webhook bridge/event ingestion is excluded from task 8 per the migration map (Stage 10). Already tracked in tech-debt.
- E2E repeated-intake deduplication test in the live harness context. Already tracked in tech-debt.
- `buildManualCandidate` `startPhase: undefined` for `In review` documentation/guard. Already tracked in tech-debt.
- `parseClientArgs` only accepts 3 of 8 canonical status names for manual intake; the allowed set and rationale should be documented when more statuses are supported.
- Environment-variable status-name validation (`client.ts:76-81`) — invalid custom status names are silently accepted and only fail at workflow runtime.

## Rejected Noise

- **"Type safety issue at `IntakeProjectDeps` boundary"** — TypeScript's structural typing makes the `createGitHubActivities()` return correctly satisfy `IntakeProjectDeps`. No cast or assertion needed.
- **"Connection cleanup early-return risk in `client.ts`"** — JavaScript `finally` blocks always execute regardless of early returns. The existing `try/finally` structure is correct.
- **"`handleWorkflowTrigger` might return `start` in the catch path"** — After `WorkflowExecutionAlreadyStartedError`, `getWorkflowState` will return `open` (since the workflow is confirmed running), so `resolveWorkflowTriggerAction` will never return `start`. The invariant is sound.
- **"Error context lost in `loadManualCandidate` call"** — The top-level `run().catch()` already logs the full error including stack trace. The status name is in the error message on the next line.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied beyond the in-repo task spec
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add a unit test for `buildManualCandidate` covering the three status mappings (`Backlog`→specify, `Ready`→implement, `In review`→undefined).
2. Optionally add a repeated-tick `runPickupIntake` unit test to strengthen AC6 proof.
3. Proceed to Task 9 (worktree cleanup policy) or address accumulated tech-debt items (error cause standardization, duplicated cause-chain helpers).
