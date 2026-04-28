## Review Scope

Reviewed the uncommitted changes on branch `feat/temporal-simplest-workflow` relative to HEAD, scoped to Task 4 (Specify phase) per `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-4.md`. Files inspected: `orchestrator/src/workflows.ts`, `orchestrator/src/phases/specify/*`, `orchestrator/src/activity-github-pull-request.ts`, `orchestrator/src/activity-github-project.ts`, `orchestrator/src/activity-github.ts`, `orchestrator/src/activity-worktree.ts`, `orchestrator/src/activity-deps.ts`, `orchestrator/src/activities.ts`, `orchestrator/src/shared.ts`, `orchestrator/src/agent-schema-registry.ts`, `orchestrator/src/mocha/workflow-shell.test.ts`, `orchestrator/src/mocha/specify-phase.test.ts`, `orchestrator/src/mocha/activity-github.test.ts`, `orchestrator/src/mocha/activity-worktree.test.ts`, `orchestrator/src/mocha/activity-agent-sequence-runtime.test.ts`, `orchestrator/src/mocha/activity-test-helpers.ts`, `e2e/src/run-e2e.ts`, `e2e/src/live-github.ts`, `e2e/src/live-github.test.ts`, `e2e/src/fake-agent.ts`, `e2e/src/fake-agent.test.ts`. No authoritative artifact was used; review was branch-only against the task plan.

## Source Artifact

The task plan at `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-4.md` was used as the reference specification. No external story/ticket was supplied.

## Acceptance / Spec Coverage

The implementation satisfies the task-4 acceptance criteria well:

1. **AC1** (Backlog → Specify → Refinement → write OpenSpec files): ✅ Covered by `runSpecifyPhase` moving to `refinementOptionId`, creating worktree, and calling `writeOpenSpecChangeFiles`.
2. **AC2** (successful spec → draft PR, upsert summary, Refined, block on `awaiting_spec_review`): ✅ Covered by phase returning `'refined'`, workflow blocking with `condition()`.
3. **AC3** (open questions → Blocked, block on `specify_needs_input`): ✅ Covered by phase returning `'needs_input'`, workflow blocking.
4. **AC4** (signal tests for `specReviewed` and `specifyRetry`): ✅ Covered by `workflow-shell.test.ts` tests including guard-rejection of irrelevant signals.
5. **AC5** (invalid structured output → repair → success; contract failure → non-retryable): ✅ Covered by `specify-phase.test.ts` and `activity-agent-sequence-runtime.test.ts`.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

- **Issue re-fetch race in specify retry loop** (`workflows.ts:119-120`): `getTopBacklogIssue(input)` is called inside the `while` loop, so every `specifyRetrySignal` re-selects the top backlog issue. If the board changed between retries (e.g., operator moved another issue to Backlog above the current one), the workflow silently switches to a different issue mid-retry. The selected issue should be cached on first selection and reused for subsequent retries within the same specify loop iteration.

### Should Fix

- **Duplicate `isNightShiftMarkerComment`** (`phases/specify/prompt.ts:54-56` vs `activity-github-pull-request.ts:28-30`): The same function is defined in two places with identical logic. Import from `activity-github-pull-request` (already exported) instead of maintaining a private copy that could diverge.

- **`nonRetryableErrorTypes: ['AgentContractError']` is ineffective** (`workflows.ts:142`): The phase catches `AgentContractError` inside `generateSpecifyResponse` and wraps it in `SpecifyPhaseContractError` before the error reaches the Temporal retry layer. The non-retryable config on the proxy never sees `AgentContractError`. Either: (a) add `'SpecifyPhaseContractError'` to the list, (b) stop wrapping the error, or (c) remove the misleading config and rely on the phase's catch-and-rethrow. Currently this is not a bug because `SpecifyPhaseContractError` still propagates and crashes the workflow (which is the intended non-retryable behavior), but the config is dead code.

- **Second validation failure is unhandled** (`phases/specify/phase.ts:51`): If the agent's repaired output also fails `validateOpenSpecChange`, the error propagates unhandled from the phase. The task plan says "Validator failure is retried once" which this satisfies, but the error message will be a raw openspec validation error with no context about it being the second attempt. Consider wrapping in a descriptive error or documenting this as intentional.

## Out-of-Scope Follow-Ups

- `openspec` binary availability is assumed but not checked at worker startup. If missing, `execFile` throws a cryptic `ENOENT`. A startup check or better error wrapping would improve operability.
- `seedIssueInProject` parameter `initialStatusName` (`live-github.ts:163`) accepts untyped `string` instead of `ProjectStatusName`. Adding the type annotation would catch invalid status names at compile time.
- `isRetryableProjectSelectionError` (`live-github.ts:515-517`) only recognizes "Ready" and "Backlog" error messages. Future phases selecting from other statuses would not be retried. A generic pattern match would be more robust.
- `updatePullRequest` (`activity-github-pull-request.ts:102-114`) falls back to dummy title/body when none is provided. Currently all callers supply explicit values, but the fallback is misleading for future use.

## Rejected Noise

- `assert.AssertionError` usage in `workflow-shell.test.ts:302` was investigated and confirmed correct per the Node.js assert API.
- The 2-minute polling timeout in `driveSpecifyApprovalGate` (120 × 1s) was investigated; it is sufficient for the fake-agent path and the live E2E is documented as green.
- The fact that `SpecifyPhaseContractError` can crash the workflow was investigated; this is the intended behavior per the task plan ("deterministic contract failures are classified separately from infrastructure/runtime failures").

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Cache the selected backlog issue outside the `while` loop in `workflows.ts` so retries operate on the same issue.
2. Remove the duplicate `isNightShiftMarkerComment` in `prompt.ts` and import from `activity-github-pull-request`.
3. Either add `'SpecifyPhaseContractError'` to `nonRetryableErrorTypes` or remove the dead `['AgentContractError']` config to avoid confusion.
