# Review: Task 8 — Pickup/Manual Intake Automation

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` at commit `6737176` against the Task 8 plan (`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`). Focused on:

- Shared intake trigger resolution (`intake.ts`: `resolveWorkflowTriggerAction`, `handleWorkflowTrigger`, `buildPickupCandidates`, `buildManualCandidate`)
- Deterministic per-issue workflow IDs (`buildIssueWorkflowId`)
- Project item `createdAt` ordering (`listProjectIssuesForStatuses`, `compareProjectIssueItems`)
- Client/manual path delegation (`client.ts` → `intake.ts`)
- Workflow-level signal-vs-noop behavior (signal gating via `allow*`/`pending*` flags, `getBlockedReasonQuery`)
- Fake-agent E2E intake-driven start proof (`e2e/src/run-e2e.ts`)
- Unit and workflow integration tests (`intake.test.ts`, `intake-workflow.test.ts`)

No authoritative artifact beyond the task-8 plan was supplied.

## Source Artifact

Task 8 plan: `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`. No external story/spec/ticket was supplied.

## Acceptance / Spec Coverage

The implementation satisfies all 7 acceptance criteria from the task-8 plan:

1. **AC1** ✅ Backlog items with no workflow → started in `specify` mode (intake.ts:95, tested at intake.test.ts:18)
2. **AC2** ✅ Ready items with no workflow → started in `implement` mode (intake.ts:96, tested at intake.test.ts:22)
3. **AC3** ✅ Intake decisions for Backlog/Ready/In-review signal blocked workflows per `BLOCKED_REASON_BOARD_SIGNAL_RULES` (intake.ts:100-103, tested at intake.test.ts:26-36)
4. **AC4** ✅ Pickup merges Backlog+Ready, sorts by `createdAt`, respects per-tick cap (intake.ts:53-57, 131-144, tested at intake.test.ts:47-129)
5. **AC5** ✅ Trigger-resolution tests cover start/signal/noop, blocked-reason mismatch, duplicate-start race (intake.test.ts:16-130)
6. **AC6** ✅ Idempotency tested via `WorkflowExecutionAlreadyStartedError` catch-and-reroute (intake.test.ts:59-91, intake-workflow.test.ts:15-54)
7. **AC7** ✅ Webhook support explicitly excluded in task-8.md and no webhook code exists

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

_(none)_

### Should Fix

- **Incomplete trigger-table test coverage in `intake.test.ts`**: Only 4 of 6 `BLOCKED_REASON_BOARD_SIGNAL_RULES` entries are directly tested. Missing explicit assertions for: `specify_needs_input` + `Backlog` → `specifyRetry`, `implement_needs_input` + `Ready` → `implementRetry`, `review_escalation` + `Ready` → `resume`. These are implicitly covered by the `.find()` lookup but should have explicit assertions to prevent regression if the rules table changes. (intake.test.ts:16-45)

- **Missing `Backlog` + `closed` and `Ready` + `missing` start-state combinations**: Test covers `Backlog` + `missing` and `Ready` + `closed` but not the cross-combinations. Add assertions for `Backlog` + `closed` → start specify, `Ready` + `missing` → start implement. (intake.test.ts:17-24)

- **Redundant double-sort in `runPickupIntake`**: Candidates are already sorted by `buildPickupCandidates` (line 56), then re-sorted identically in `runPickupIntake` (line 138). The defensive spread `[...candidates]` is fine, but the identical `.sort()` is pure waste. Remove the sort from `runPickupIntake` and rely on `buildPickupCandidates` ordering, or document why `runPickupIntake` must independently guarantee order. (intake.ts:138)

## Out-of-Scope Follow-Ups

- **Webhook bridge/event ingestion**: Explicitly excluded from task 8. Should be addressed in a future task per the migration map.
- **E2E repeated-intake deduplication test**: The orchestrator unit/integration tests prove idempotency, but the E2E suite (`run-e2e.test.ts`) has no test proving repeated intake for the same issue avoids workflow duplication in the live harness context.
- **`buildManualCandidate` semantic gap for `In review`**: When `currentStatusName` is `In review`, `startPhase` is `undefined`. This is correct for the signal path (signals don't need a startPhase) but semantically incomplete. Document explicitly or add a guard if `In review` items should never trigger a start.

## Rejected Noise

- **Stale `getWorkflowState` race between check and start**: This is inherent to Temporal's API and is correctly mitigated by the `WorkflowExecutionAlreadyStartedError` catch-and-reroute pattern. No action needed.
- **Query-signal timing window**: Between querying `blockedReason` and sending the signal, the workflow may unblock. This is safe because signal handlers gate on `allow*` flags — late signals are silently ignored.
- **Stale `pendingResume` clearing at line 215 of workflows.ts**: This defensive clearing before the implement loop is inconsistent with other pending flags but harmless. The pattern is safe.
- **`assert.AssertionError` spelling at intake-workflow.test.ts:155**: This is the correct Node.js `assert` module API, not a typo.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no external authoritative artifact supplied beyond the task plan
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add explicit trigger-table assertions for the 3 missing `BLOCKED_REASON_BOARD_SIGNAL_RULES` entries and the 2 missing start-state cross-combinations in `intake.test.ts`.
2. Remove the redundant `.sort()` from `runPickupIntake` line 138 (or add a comment justifying it as a defensive measure for callers who bypass `buildPickupCandidates`).
3. Proceed to Task 9 after these minor test gaps are addressed.
