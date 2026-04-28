# Review — Task 3 Deterministic Phases Migration (Phased Workflow Shell)

## Review Scope

Reviewed uncommitted changes on `feat/temporal-simplest-workflow` in these files:

- `orchestrator/src/workflows.ts` (+157 −8)
- `orchestrator/src/shared.ts` (+5)
- `orchestrator/src/mocha/workflow-test-helpers.ts` (+43 −2)
- `orchestrator/src/mocha/workflow-shell.test.ts` (new, untracked, 122 lines)

No authoritative artifact (`task-3.md`) was found in the repository. The review evaluated the diff against inferred acceptance criteria: introduce a phased workflow shell with `specify → implement → review` phase transitions, signal/query handlers, and `setCurrentDetails` integration.

## Source Artifact

No authoritative artifact was supplied or resolvable. The file `task-3.md` was not found anywhere in the repository.

## Acceptance / Spec Coverage

Without a formal artifact, coverage is assessed against inferred intent:

| Criterion (inferred) | Status |
|---|---|
| `WorkflowPhase` type and `WORKFLOW_PHASES` const in shared | ✅ Present |
| `startPhase` on `AutomateReadyIssueInput` (optional, defaults to `'implement'`) | ✅ Present |
| Phase-aware shell in `automateTopReadyIssue` with `specify` wait loop | ✅ Present |
| Signal handlers gated by allow-flags (specifyRetry, specReviewed, implementRetry, resume) | ✅ Present |
| `activityProgressSignal` wired to `setCurrentDetails` | ✅ Present |
| `getBlockedReasonQuery` query handler | ✅ Present |
| `renderWorkflowCurrentDetails` pure function | ✅ Present |
| `runWorkflowWithHandle` test helper for signal/query testing | ✅ Present |
| Tests: implement-start happy path, specify→implement signal roundtrip, render unit test | ✅ 3 tests present |
| Backward compatibility: existing callers without `startPhase` default to `'implement'` | ✅ Verified |

## Previous Review Verification

Verification was skipped — no previous review was supplied.

## Findings

### Must Fix

_(none)_

### Should Fix

- **No test for implement-phase error path with new shell state mutations** (`workflows.ts:219–221`). The catch block now sets `shellState.blockedReason = 'implement_needs_input'` and updates `latestActivity`, but `workflow-shell.test.ts` has no test exercising this path. The existing `workflow.test.ts` tests may cover the error path functionally, but the new shell-state side-effects (blockedReason, latestActivity on failure) are untested. Consider adding a test in `workflow-shell.test.ts` that verifies `getBlockedReasonQuery` returns `'implement_needs_input'` after an activity failure.

- **Dead placeholder variables lack explanatory comments** (`workflows.ts:80–81, 84–85, 137–138`). `allowImplementRetry` and `allowResume` are `const false`, so `pendingImplementRetry` and `pendingResume` can never become `true`, making lines 137–138 dead code. This is clearly intentional scaffolding for a future task, but a brief `// Placeholder: wired when implement/review retry loops are added` comment would prevent future reviewers from treating it as a bug.

## Out-of-Scope Follow-Ups

- Review phase is a terminal no-op: `currentPhase` transitions to `'review'` then the workflow returns. Wiring the review-phase retry loop is future work.
- `implementRetry` and `resume` signal handlers are registered but permanently gated off. Activating them with their respective phase loops is future work.

## Rejected Noise

- **Null-guard removal around `failureStatusOptionId`**: The removed `if (failureStatusOptionId)` guard was redundant — `resolveFailureStatusOptionId` returns `issue.blockedOptionId` which is typed as required `string` in `SelectedProjectIssue`. The catch block still surrounds the call, so a runtime empty-string edge case would produce a caught API error rather than a silent skip, which is strictly better behavior.
- **`WorkflowShellState` is not exported**: It is intentionally module-private; tests interact through the exported `renderWorkflowCurrentDetails` function. This is correct encapsulation.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: task-3.md not found in repository; reviewed diff against inferred acceptance criteria
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add a test in `workflow-shell.test.ts` for the implement-phase error path that asserts `getBlockedReasonQuery` returns `'implement_needs_input'` after an activity throws.
2. Add a one-line comment on the `const allowImplementRetry = false` / `const allowResume = false` declarations noting they are placeholder scaffolding.
3. Commit and proceed to the next task (wiring the review-phase loop or implementing the `specify` phase activities).
