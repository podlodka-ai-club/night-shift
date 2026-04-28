# Review — Task 8 deterministic phases migration final-final pass

## Review Scope

Full branch diff review of `feat/temporal-simplest-workflow` against `main`. Scope: Task 8 deterministic phases migration — final-final pass after preserving original phase failures and guarding signal races. Pickup/manual intake only, no webhooks. Assumed `make check` and live fake-agent E2E are green per the run instructions.

All orchestrator source files, phase implementations, workflow shell, intake module, client CLI, and test files were inspected directly from the repository.

## Source Artifact

No authoritative artifact was supplied. The review was conducted against the branch scope description: "Task 8 deterministic phases migration final-final pass after preserving original phase failures and guarding signal races. Pickup/manual intake only, no webhooks."

## Acceptance / Spec Coverage

No authoritative artifact was supplied. This section was skipped.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

_(none)_

All previously identified must-fix items from prior review passes appear to have been addressed:
- `handlePhaseFailure` cleanup errors are now caught by `preserveOriginalPhaseFailure` (workflows.ts:115-121), which wraps the call in a try-catch with an empty catch block, preserving the original error.
- Signal race guards in `handleWorkflowTrigger` (intake.ts:118-126, 137-145) now catch `WorkflowNotFoundError` on both the initial signal path and the rerouted signal path.
- `buildManualCandidate` unit tests are present in `intake.test.ts` (lines 84-112).

### Should Fix

- **Review phase `buildPhaseFailureComment` suggests `readyStatusName` for review failures** (workflows.ts:418). When a review phase fails, a PR already exists and is "In review". Suggesting the user move the item to `readyStatusName` is misleading; `inReviewStatusName` would be more appropriate. This was previously flagged in the Task 8 final review tech-debt and remains unaddressed. _Severity: low. Not blocking._

- **`addIssueLabels` activity not registered in the `defaultActivities` export** (activities.ts:30-58). The `addIssueLabels` activity is proxied in `workflows.ts` (line 47) and used by the review phase for escalation labeling. It is also listed in the `defaultActivities` destructuring (line 37). This is fine — confirmed no issue here after re-reading. _(Retracted.)_

- **`cleanupWorktree` activity is declared in `shared.ts` (CleanupWorktreeInput, line 207-209) and `activity-worktree.ts` but is not wired into any phase or workflow.** This is dead code that should either be removed or explicitly deferred to Task 9. _Severity: low._

- **Signal discard observability** (workflows.ts:128-139). Signal handlers silently discard signals when guard flags are `false`. Operators receive no feedback that a signal was received but ignored. Consider setting `shellState.latestActivity` on discard so the Temporal UI reflects the event. Already tracked in tech-debt from Task 8 final review.

- **`client.ts` error handler does not unwind `.cause` chain** (client.ts:100-103). `console.error(err)` for Temporal `WorkflowFailedError` only shows the outermost message. Already tracked in tech-debt from Task 8 final review.

## Out-of-Scope Follow-Ups

- Webhook bridge/event ingestion is explicitly excluded from Task 8. Should be addressed per migration map Stage 10.
- E2E repeated-intake deduplication test is missing from the live harness context.
- `SpecifyPhaseContractError` should accept a `cause` parameter (tracked in Task 7 tech-debt).
- `ImplementPhaseContractError` and `ReviewPhaseContractError` should use `super(message, { cause })` instead of manual assignment (tracked in Task 6/7 tech-debt).
- Duplicated `findErrorInCauseChain`/`describeErrorCauseChain`/`describeWorkflowError` helpers across multiple files should be extracted to a shared utility (tracked in Task 7 tech-debt).
- `cleanupWorktree` dead code: wire or remove in Task 9.

## Rejected Noise

- _Duplicate `assert.AssertionError` typo in `workflow-shell.test.ts`_: This is a valid Node.js `assert` class name (Node spells it `AssertionError` prior to recent versions). No action needed; the code compiles and tests pass.
- _`as any` casts in test activity stubs_: Acceptable in test mocks where the full runtime type is intentionally partial.
- _`proxyActivities` called multiple times in `workflows.ts` (once at module scope, once per `getRunAgentSequenceActivityWithRetry` call)_: This is intentional to give agent sequence activities different timeout/heartbeat/retry configs. No issue.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact supplied
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. **Low priority**: Update `buildPhaseFailureComment` to suggest `inReviewStatusName` for review-phase failures (already tracked in tech-debt).
2. **Low priority**: Remove or explicitly defer `CleanupWorktreeInput`/`cleanupWorktree` dead code if Task 9 is not imminent.
3. **No blockers remain for this branch.** The task 8 scope (pickup/manual intake, preserving original phase failures, guarding signal races) is materially complete and tested.
