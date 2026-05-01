# Task 12 Review — Verification Pass

## Review Scope

Verification-focused review of branch `feat/temporal-simplest-workflow` against the authoritative artifact `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-12.md`. Examined `worker.ts`, `activity-deps.ts`, `activity-agent-sequence.ts`, `activity-agent-turn.ts`, `workflows.ts`, `run-e2e.ts`, `fake-agent.ts`, and their associated test files. Primary focus: confirming resolution of the three Must Fix findings from the prior review (connection cleanup leak, late `WorkflowNotFoundError`, and signal connection cleanup ordering).

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-12.md` — Task 12: Stream agent-authored progress summaries into Temporal UI.

## Acceptance / Spec Coverage

All seven ACs remain satisfied at the same level as the prior review. AC5 (bounded liveness fallback) is still unimplemented, which remains acceptable per the spec's "may" language.

## Previous Review Verification

All three prior **Must Fix** findings are now fully resolved:

1. **`worker.ts` — Connection leak on `Connection.connect` failure** → **Fixed.** Extracted to `openWorkerConnections` (lines 103–125): if `connectSignal` throws, the already-opened native connection is closed in a nested try/catch that preserves the original error. Covered by test at `worker.test.ts:105-128`.

2. **`worker.ts` — `signalConnection.close()` failure leaks `connection`** → **Fixed.** Extracted to `closeWorkerConnections` (lines 127–148): independent try/catch blocks guarantee both connections are attempted. Covered by test at `worker.test.ts:131-153`.

3. **`activity-deps.ts` — Unhandled `WorkflowNotFoundError` on late progress signal** → **Fixed.** `signalActivityProgress` (lines 333–340) now catches `WorkflowNotFoundError` and returns silently.

Prior **Should Fix** items — status:

4. **`forwardFallbackTurnEvents` dead code** → **Not fixed.** Still present at `activity-agent-turn.ts:71`. Carried forward as should-fix.
5. **`Promise.resolve()` wrapper redundant** → **Fixed.** Line 107 now reads `void deps.signalProgress(normalizedMessage).catch(() => undefined)`.
6. **Fire-and-forget ordering** → **Not fixed.** Still best-effort ordering. Low priority; carried forward.
7. **`waitForWorkflowCurrentDetailsMatch` race condition** → **Partially fixed.** A post-loop final check was added (line 359), which mitigates the most common race. However, the window between `workflowFinished = true` and the final query could still miss a signal that lands after the workflow result resolves but before the last query executes. Acceptable for an E2E polling harness.
8. **`recentActivities` type/init inconsistency** → **Fixed.** Field is now `string[]` (required) and initialized to `[]`.
9. **Test coverage gaps** → **Partially fixed.** Dedup test exists (`activity-agent-sequence-runtime.test.ts:94`). Bounded-history slicing test, signal→workflow→render pipeline test, and negative-path test for `assertFakeAgentWorkflowCurrentDetails` are still missing.
10. **Magic string `'__temporal_workflow_metadata'`** → **Not fixed.** Still hardcoded at `run-e2e.ts:337`.
11. **Extra blank line `run-e2e.ts:377`** → Not verified; trivial.
12. **`as any` casts in `workflow-shell.test.ts`** → **Not fixed.** Multiple `as any` casts remain (lines 159, 188, 272, 291, 320, 488, 500, 874, 903).

## Findings

### Must Fix

- None. All prior must-fix items are resolved.

### Should Fix

- **`activity-agent-turn.ts:71` — `forwardFallbackTurnEvents` remains likely dead code.** `assertCodexTurnResult` already maps `items` → `events`. If intended for future non-Codex adapters, add a comment; otherwise remove to avoid masking bugs. (Carried from prior review.)
- **`run-e2e.ts:337` — Magic string `'__temporal_workflow_metadata'`** should be extracted to a named constant or documented. (Carried from prior review.)
- **Test gaps remain:** No test for bounded-history slicing (e.g., inserting 5 items verifies only last 3 survive via `appendRecentActivity`). No signal→workflow→render end-to-end pipeline test. No negative-path test for `assertFakeAgentWorkflowCurrentDetails` (verifying it fails when details are missing or non-matching). (Carried from prior review, partially addressed.)

## Out-of-Scope Follow-Ups

- AC5 liveness/silence fallback: implement a heartbeat-based liveness indicator if workflows appear frozen during long agent turns. (Already tracked in tech-debt.)
- `extractAssistantTextFromProviderItem` repeated `as` casts on `unknown` — use a type guard or `.safeParse`. (Already tracked in tech-debt.)
- `recordActivity` naming collision with Temporal's own "activity" concept. (Already tracked in tech-debt.)
- `ReturnType<TestWorkflowEnvironment['client']['workflow']['getHandle']>` repeated three times in `run-e2e.ts` — extract a type alias. (Already tracked in tech-debt.)

## Rejected Noise

- `as any` casts in `workflow-shell.test.ts` are test-only ergonomic shortcuts for constructing mock contract outputs. Not a production concern and can be addressed incrementally.
- Fire-and-forget signal ordering is inherent to the design choice and acceptable for progress-summary semantics (summaries are not order-critical for operators).
- The `waitForWorkflowCurrentDetailsMatch` race window is acceptable for an E2E polling harness — the post-loop final check adequately mitigates the common case.

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 5
- Verification Partially Fixed: 2
- Verification Not Fixed: 3
- Verification Not Applicable: 1

## Recommended Next Actions

1. Add a comment on `forwardFallbackTurnEvents` documenting its purpose for future non-Codex adapters, or remove it if that future is not planned.
2. Extract `'__temporal_workflow_metadata'` to a named constant shared between `run-e2e.ts` and any other consumer.
3. Add the missing bounded-history slicing test for `appendRecentActivity` in `workflow-shell.test.ts`.
