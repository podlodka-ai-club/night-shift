# Review — Task 8 Deterministic Phases Migration (Pickup/Manual Intake)

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` against `main` with focus on Task 8 acceptance criteria: pickup/manual intake trigger resolution, `buildManualCandidate` coverage, `runPickupIntake` idempotency, and signal-vs-start-vs-noop correctness. Primary files inspected: `intake.ts`, `client.ts`, `mocha/intake.test.ts`, `mocha/intake-workflow.test.ts`, plus `workflows.ts` (phase-failure handling, review loop, escalation/resume), `shared.ts` (`ListedProjectIssue`, `ListProjectIssuesByStatusInput`), `activity-github.ts`/`activity-github-project.ts` (`listProjectIssuesByStatusActivity`). All 119 unit/integration tests pass. `make check` passes from the repository root.

No authoritative artifact was supplied beyond the in-repo task spec (`task-8.md`).

## Source Artifact

Task 8 spec: `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`. No external story or ticket artifact was supplied.

## Acceptance / Spec Coverage

All seven acceptance criteria appear satisfied:

1. **AC1 — Backlog → specify start**: `resolveWorkflowTriggerAction` returns `start` with `startPhase: 'specify'` for Backlog items with no running workflow. Tested in `intake.test.ts` lines 19-23.
2. **AC2 — Ready → implement start**: Same function returns `start` with `startPhase: 'implement'` for Ready items. Tested lines 27-32.
3. **AC3 — Signal blocked workflows**: `BLOCKED_REASON_BOARD_SIGNAL_RULES` is consumed by `resolveWorkflowTriggerAction` to match board status + blocked reason → signal name. All six rule combinations tested lines 34-57.
4. **AC4 — Pickup merge + sort + cap**: `buildPickupCandidates` merges Backlog/Ready, sorts by `createdAt` then `issueNumber`. `runPickupIntake` respects `maxActions`. Tested lines 68-78 and 144-180.
5. **AC5 — Trigger resolution tests**: Start, signal, noop, blocked-reason mismatch, duplicate-start race recovery, unsupported status — all covered in `intake.test.ts`.
6. **AC6 — Idempotency**: Repeated `runPickupIntake` ticks on the same item prove the second tick produces an empty action list (test lines 182-210). Workflow-level integration tests in `intake-workflow.test.ts` prove signal-instead-of-duplicate behavior.
7. **AC7 — Webhook exclusion**: No webhook bridge, event ingestion, or board-transition listener is present. `intake.ts` and `client.ts` support only pickup and manual modes.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

- **`handlePhaseFailure` cleanup error can permanently replace the original phase error** (`workflows.ts:96–113`, called at lines 169, 251, 306). If `moveProjectItemStatus` or `upsertIssueComment` throws inside `handlePhaseFailure` (e.g. GitHub API down after 3 retries), the cleanup error propagates *before* the `throw error` on the next line executes. The original root cause is permanently lost — the Temporal UI shows a `moveProjectItemStatus` failure, not the phase error that triggered the catch. Wrap the cleanup body in a try-catch that swallows cleanup failures and always re-throws the original:
  ```typescript
  } catch (error) {
    try { await handlePhaseFailure(phase, issue, error); } catch { /* best-effort */ }
    throw error;
  }
  ```

### Should Fix

- **Signal path `WorkflowNotFoundError` unhandled in `handleWorkflowTrigger`** (`intake.ts:117, 128`). If a workflow completes between `getWorkflowState` (returns `open`) and `signalWorkflow`, the signal call throws `WorkflowNotFoundError`. This crashes the entire pickup loop. The `WorkflowExecutionAlreadyStartedError` catch on the start path is well-designed, but the signal path has no analogous guard. Catch `WorkflowNotFoundError` on the signal paths and treat as a noop.

- **Off-by-one in review iteration log message** (`workflows.ts:313`). After `shellState.reviewIteration += 1`, the message uses `shellState.reviewIteration + 1`, double-counting. When `reviewIteration` reaches `maxReviewIterations - 1` (=2), the log says "review iteration 4" for a max of 3. Either move the increment after the log or use `shellState.reviewIteration` in the message.

- **Missing unit test for `open` workflow with `blockedReason: null` → `already_running` noop**. This is the most common noop case (healthy running workflow, no blocked reason) and is not explicitly asserted in `intake.test.ts`. Add a one-line assertion.

- **`loadManualCandidate` returns `issues[0]` without a sort guarantee** (`intake.ts:87`). Pickup uses `buildPickupCandidates` which sorts by `createdAt`. Manual intake relies on the raw order from `listProjectIssuesByStatusActivity`, which does sort internally, but `loadManualCandidate` doesn't make this contract explicit. Consider documenting or asserting the sort invariant.

- **`buildPhaseFailureComment` suggests `readyStatusName` for review failures** (`workflows.ts:410`). Both `implement` and `review` failures suggest "move to Ready". For a review failure where a PR already exists, suggesting Ready (= re-implement) may be misleading. Consider suggesting `inReviewStatusName` for review failures.

## Out-of-Scope Follow-Ups

- Webhook bridge/event ingestion (deferred to migration map Stage 10).
- E2E repeated-intake deduplication test in the live harness context (unit tests cover idempotency; live E2E requires GitHub credentials).
- Signal handler observability: when guard flags are false, signals are silently dropped. Operators get no feedback. Consider updating `shellState.latestActivity` on discard.
- `client.ts` top-level error handler (`console.error(err)`) does not print the `.cause` chain. Temporal's `WorkflowFailedError` wraps the actual cause; operators see only the outermost message.
- Environment-variable status-name overrides (`client.ts:76-81`) are not validated against `CANONICAL_PROJECT_STATUS_NAMES`.

## Rejected Noise

- `IntakeCandidate.startPhase` being unused by `resolveWorkflowTriggerAction` (which derives start phase from `boardStatusName` independently) — this is a deliberate separation of candidate metadata from trigger resolution logic. The field serves the pickup-candidate layer for informational purposes and future webhook intake. Not a bug.
- `createTemporalWorkflowTriggerDeps` treating `FAILED`/`COMPLETED`/`TERMINATED` workflows identically as `closed` — correct for trigger resolution (all result in a fresh start). Distinguishing them is a diagnostic enhancement, not a correctness issue.
- Integration test workflow IDs (`ticket-7`) being non-unique across runs — Temporal test server resets between test runs. Not a real issue.
- `pendingResume` cleared at line 215 between phase loops — defensive cleanup for signals that cannot arrive due to guard flags. Correct behavior.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied beyond the in-repo task spec
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Wrap `handlePhaseFailure` call sites in try-catch to preserve the original phase error (must-fix).
2. Guard the signal path in `handleWorkflowTrigger` against `WorkflowNotFoundError`.
3. Fix the off-by-one in the review iteration log message.
4. Add a unit test for the `open`/`blockedReason: null` → `already_running` noop case.
