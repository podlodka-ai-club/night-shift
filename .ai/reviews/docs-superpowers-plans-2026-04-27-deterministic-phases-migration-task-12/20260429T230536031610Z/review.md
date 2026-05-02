# Task 12 Review — Stream agent-authored progress summaries into Temporal UI

## Review Scope

Reviewed all 15 unstaged modified files on branch `feat/temporal-simplest-workflow` at commit `0f39315` (HEAD) against the authoritative artifact `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-12.md`. Changes span orchestrator core (activity-agent-sequence, activity-agent-turn, activity-deps, workflows, worker, activities), tests (activity-agent-sequence-runtime, workflow-shell, activity-test-helpers), E2E harness (fake-agent, run-e2e), and documentation (README). `make check` passes.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-12.md` — Task 12: Stream agent-authored progress summaries into Temporal UI.

## Acceptance / Spec Coverage

| AC | Status | Notes |
|----|--------|-------|
| AC1: Receive and render intermediate assistant-authored progress | ✅ Met | `extractAssistantProgressMessage` filters provider items; `activityProgressSignal` flows to `recordActivity` → `renderWorkflowCurrentDetails`. |
| AC2: Raw tool-use/tool-result excluded from Temporal UI | ✅ Met | `extractAssistantProgressMessage` returns `undefined` for non-`provider-item` or non-assistant event types; tested in `activity-agent-sequence-runtime.test.ts`. |
| AC3: Explicit final/operator-facing summaries at phase boundaries | ✅ Met | All phase transitions use `recordActivity(...)` with deterministic messages; existing final-summary tests remain intact. |
| AC4: Dashboard preserves existing phase/blocking/completion info | ✅ Met | `renderWorkflowCurrentDetails` appends `Recent summaries` section without altering existing fields. |
| AC5: Bounded liveness fallback for long-running no-summary turns | ⚠️ Partial | No explicit liveness/silence fallback is implemented. The spec says "may" so this is acceptable, but no test documents the decision. |
| AC6: Tests cover filtering, rendering, final summaries, fallback | ⚠️ Partial | Core filtering and rendering tested. No fallback test. Bounded-history slicing not tested at append level. No signal→workflow→render end-to-end test. |
| AC7: Documentation explains new behavior | ✅ Met | `orchestrator/README.md` updated with two lines explaining assistant-authored summaries and tool-noise exclusion. |

## Previous Review Verification

Previous review verification was skipped. No previous review was supplied.

## Findings

### Must Fix

- **`worker.ts:66-72` — Connection leak on `Connection.connect` failure.** If `NativeConnection.connect` succeeds (line 66) but `Connection.connect` (line 69) throws, `connection` is never closed because the `try` block on line 72 hasn't been entered yet. Move `signalConnection` creation inside the `try` block, or restructure with nested try/finally.

- **`worker.ts:97-98` — `signalConnection.close()` failure leaks `connection`.** In the `finally` block, if `signalConnection.close()` throws, `connection.close()` is never called. Use nested try/finally or `Promise.allSettled`-style cleanup to guarantee both close.

- **`worker.ts` / `activity-deps.ts` — Unhandled `WorkflowNotFoundError` on late progress signal.** `signalClient.workflow.getHandle(workflowId).signal(...)` can throw `WorkflowNotFoundError` if the workflow completes between the activity starting and the signal arriving. The fire-and-forget pattern in `activity-agent-sequence.ts:107` swallows this, but `signalActivityProgress` in `activity-deps.ts:322` does not — a late signal from a non-fire-and-forget call path could propagate as an activity failure. Add `WorkflowNotFoundError` handling at the signal callsite in worker.ts or activity-deps.ts.

### Should Fix

- **`activity-agent-turn.ts:71-86` — `forwardFallbackTurnEvents` is likely dead code.** `assertCodexTurnResult` in `activity-deps.ts:283-303` already maps `items` → `events` for all Codex sessions. The fallback only triggers when `events` is absent, but the Codex adapter always populates it. If this is intended for future non-Codex adapters, add a comment; otherwise remove to avoid masking bugs.

- **`activity-agent-sequence.ts:107` — `Promise.resolve()` wrapper is redundant.** `deps.signalProgress(...)` already returns `Promise<void>`. Change to `void deps.signalProgress(normalizedMessage).catch(() => undefined)`.

- **`activity-agent-sequence.ts:101-108` — Fire-and-forget has no ordering guarantee.** Rapid calls can interleave, causing signals N+1 to arrive before N. If UI assumes monotonic ordering, this is a latent issue. Document that ordering is best-effort, or consider sequential queuing.

- **`run-e2e.ts:341-361` — Race condition in `waitForWorkflowCurrentDetailsMatch`.** The fire-and-forget signal delivery means `setCurrentDetails` in the workflow may not have landed by the time polling observes the workflow. The workflow can complete (setting `workflowFinished = true`) before the signal handler runs, causing the poll loop to exit with stale details. Consider adding a settling delay after `workflowFinished` before the final check, or using event-based observation rather than polling.

- **`workflows.ts:88` — `recentActivities` type/init inconsistency.** Field typed as `string[] | undefined` but always initialized to `[]` in `createWorkflowShellState`. Either make the field required (`string[]`) or don't initialize it.

- **Test coverage gaps:**
  - No test for bounded-history slicing behavior (e.g., 5 items → only last 3 survive).
  - No test for non-consecutive dedup (e.g., `[A, B, A]` → all three emitted).
  - No test exercising `activityProgressSignal` → workflow signal handler → `recentActivities` → rendered details end-to-end.
  - `workflow-shell.test.ts:827` uses `as any` cast instead of properly-typed `WorkflowShellState`.
  - No negative-path test for `assertFakeAgentWorkflowCurrentDetails` (missing details, non-matching content).

- **`run-e2e.ts:337` — Magic string `'__temporal_workflow_metadata'`.** Extract to a named constant or document the coupling to Temporal's internal query name.

- **`run-e2e.ts:377` — Extra blank line** before `seedApprovedSpecBundle`. Trivial but noisy.

## Out-of-Scope Follow-Ups

- AC5 liveness/silence fallback: the spec says "may"; if it becomes desired, implement a heartbeat-based liveness indicator that updates current details when no assistant message arrives within a configurable timeout.
- `extractAssistantTextFromProviderItem` uses `as` casts on `unknown` repeatedly. A type guard or `.safeParse` approach would be more idiomatic.
- `recordActivity` naming collides conceptually with Temporal's own "activity" concept. Consider `recordProgress` or `updateLatestProgress`.
- `ReturnType<TestWorkflowEnvironment['client']['workflow']['getHandle']>` is repeated three times in `run-e2e.ts`. Extract a type alias.

## Rejected Noise

- The dual-connection pattern (NativeConnection for worker, Connection for signals) is architecturally correct — Temporal workers require NativeConnection while the JS client API uses Connection. Not a concern.
- `appendRecentActivity` creating a temporary array via spread+slice for a size-3 list is negligible overhead. Not worth optimizing.
- The `new Function('specifier', ...)` dynamic import hack in `activity-deps.ts:98` is pre-existing code, not part of this task.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Fix the connection leak in `worker.ts` by moving `signalConnection` creation inside the `try` block and restructuring cleanup with nested try/finally.
2. Add `WorkflowNotFoundError` catch at the signal callsite (worker.ts or activity-deps.ts).
3. Address the `waitForWorkflowCurrentDetailsMatch` race condition — add a post-completion settling delay or switch to event-based observation.
4. Add the missing test cases: bounded-history slicing, non-consecutive dedup, signal→workflow→render pipeline.
5. Resolve the `recentActivities` type/init inconsistency and remove the redundant `Promise.resolve()` wrapper.
