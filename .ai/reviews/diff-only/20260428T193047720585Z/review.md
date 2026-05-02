# Review — Task 8 Deterministic Phases Migration (follow-up fixes)

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` against `main` with focus on Task 8 acceptance criteria after follow-up fixes: pickup/manual intake only (no webhook support). Inspected `intake.ts`, `intake.test.ts`, `intake-workflow.test.ts`, `client.ts`, `shared.ts`, `workflows.ts`, `activity-github-project.ts`, `activity-github.ts`, `activities.ts`, `worker.ts`, `run-e2e.ts`, `run-e2e.test.ts`, `fake-agent.ts`, `fake-agent.test.ts`, `run-contract.ts`, `run-contract.test.ts`, and all workflow/phase test files. `make check` passes (all orchestrator and e2e tests green, both workspaces build cleanly).

## Source Artifact

Task 8 spec: `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`. No external story/ticket artifact was supplied.

## Acceptance / Spec Coverage

This section was evaluated against the in-repo task spec since no external artifact was supplied.

1. **AC1 — Backlog items started in specify mode**: `resolveWorkflowTriggerAction` returns `{ type: 'start', startPhase: 'specify' }` for `boardStatusName: 'Backlog'` with `kind: 'missing'` or `kind: 'closed'`. Tested in `intake.test.ts` line 18.
2. **AC2 — Ready items started in implement mode**: Same function returns `{ type: 'start', startPhase: 'implement' }` for `boardStatusName: 'Ready'`. Tested in `intake.test.ts` lines 26-31.
3. **AC3 — Signal transitions match the copied contract**: `BLOCKED_REASON_BOARD_SIGNAL_RULES` in `shared.ts` defines the full signal-vs-noop table. `resolveWorkflowTriggerAction` consumes it at runtime. All six signal rules plus blocked-reason mismatch and unsupported-start-status noop paths are tested in `intake.test.ts` lines 16-65.
4. **AC4 — Pickup merges Backlog+Ready, sorts by createdAt, respects cap**: `buildPickupCandidates` merges and sorts by `createdAt` then `issueNumber`. `runPickupIntake` enforces `maxActions`. Tested in `intake.test.ts` lines 67-149.
5. **AC5 — Trigger-resolution tests**: Start vs signal vs noop, blocked-reason mismatch, duplicate pickup race (WorkflowExecutionAlreadyStartedError recovery), and closed/prior-run restart all covered in `intake.test.ts`. Integration-level signal-vs-noop proven in `intake-workflow.test.ts` against real Temporal test server.
6. **AC6 — Idempotency**: `handleWorkflowTrigger` catches `WorkflowExecutionAlreadyStartedError` and re-resolves, preventing duplicates. Integration test in `intake-workflow.test.ts` lines 15-54 signals a blocked workflow instead of starting a duplicate.
7. **AC7 — Webhook out of scope**: No webhook bridge, webhook event ingestion, or board-transition listener exists in the codebase. `client.ts` only supports `pickup` and manual `Backlog`/`Ready`/`In review` modes.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

_(none)_

### Should Fix

- **`buildManualCandidate` leaves `startPhase` undefined for `In review` items** (`intake.ts:64`). When `currentStatusName` is `In review`, the `startPhase` field is `undefined`. This is correct behavior for the signal path (since `In review` items should only signal, never start), but the lack of an explicit guard means a future code change could accidentally try to start a workflow with `startPhase: undefined`. Add an explicit comment or a runtime guard that rejects `In review` items from the start path. Already tracked in tech-debt.

- **E2E repeated-intake deduplication test gap**: The orchestrator unit/integration tests prove idempotency (`intake.test.ts` duplicate-start race, `intake-workflow.test.ts` signal-vs-duplicate), but the E2E suite (`run-e2e.test.ts`) lacks a test proving repeated intake for the same issue avoids workflow duplication in the live harness context. Already tracked in tech-debt.

- **`listProjectIssuesByStatus` is not registered as a workflow activity** — it is exported from `activities.ts` as a default activity binding (line 35) but is not proxied inside `workflows.ts`. This is correct because intake resolution happens in the client (`client.ts`), not inside the workflow. However, the asymmetry could confuse future contributors. Add a brief comment in `activities.ts` or `intake.ts` explaining that `listProjectIssuesByStatus` is intentionally a client-side-only activity.

### Residual tech-debt items (already tracked, confirmed still open)

- `SpecifyPhaseContractError` discards `cause` (from Task 7).
- `ImplementPhaseContractError` and `ReviewPhaseContractError` use manual cause assignment instead of `super(message, { cause })` (from Tasks 5-7).
- Duplicated `describeErrorCauseChain` / `describeWorkflowError` helpers (from Task 7).

## Out-of-Scope Follow-Ups

- Webhook bridge/event ingestion (explicitly excluded per Task 8 spec; tracked in tech-debt).
- Worktree corruption recovery (Task 9).
- E2E repeated-intake deduplication test (already tracked in tech-debt).

## Rejected Noise

- `IntakeCandidate.issue` uses a union type `SelectedProjectIssue | ListedProjectIssue` — this is intentional to support both manual and pickup paths without unnecessary conversion.
- `createTemporalWorkflowTriggerDeps` uses `describe()` to check workflow status — this is the correct Temporal client API for inspecting workflow state without running queries on closed workflows.
- The `resolveSignalDefinition` switch has no `default` case — TypeScript's exhaustive check via the `WorkflowSignalName` type union handles this at compile time.
- `AssertionError` in test helpers — this is Node's actual class name, not a typo.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied beyond the in-repo task spec
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add a brief comment or guard for `buildManualCandidate`'s `In review` → `undefined` startPhase path.
2. Add a comment in `activities.ts` or `intake.ts` explaining `listProjectIssuesByStatus` is client-side only.
3. Proceed to Task 9 (worktree cleanup/corruption recovery).
