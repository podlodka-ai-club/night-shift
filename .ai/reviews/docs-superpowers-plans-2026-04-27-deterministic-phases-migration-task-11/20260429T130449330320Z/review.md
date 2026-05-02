# Task 11 Review — Donor-Style Scheduled Pickup Workflow

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` against the authoritative artifact `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-11.md`. Inspected all task-11 implementation files: `pickup.ts`, `pickup-activities.ts`, `worker.ts` (schedule bootstrap), `workflows.ts` (`pickupWorkflow`), `config.ts` (pickup schema), `entrypoint-config.ts` (worker/client pickup resolution), and all associated test files (`pickup.test.ts`, `pickup-workflow.test.ts`, `worker.test.ts`, `config.test.ts`, `entrypoint-config.test.ts`). Also verified `client.ts` manual intake path, `intake.ts` shared contract, `README.md` documentation, and the e2e harness. All 147 unit/integration tests pass.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-11.md` — donor-style scheduled pickup workflow.

## Acceptance / Spec Coverage

| AC | Status | Evidence |
|----|--------|----------|
| 1. Dedicated scheduled pickup workflow exists, startable by a Temporal Schedule | ✅ | `pickupWorkflow` in `workflows.ts:387-397`; schedule action references `workflowType: 'pickupWorkflow'` in `worker.ts:29` |
| 2. Worker startup creates/updates pickup schedule idempotently with stable id | ✅ | `ensurePickupSchedule` in `worker.ts:40-60`; stable `PICKUP_SCHEDULE_ID = 'pickup-schedule'`; tested in `worker.test.ts` (create + update paths) |
| 3. Scheduled pickup reuses existing intake semantics | ✅ | `pickup-activities.ts` calls `loadPickupCandidates` and `runPickupIntake` from `intake.ts`; `pickup.ts:runScheduledPickup` does the same |
| 4. Pickup enabled by default; explicit config can disable | ✅ | `config.ts:37`: `enabled: z.boolean().default(true)`; `worker.ts:82`: guarded by `config.pickup.enabled`; tested in `config.test.ts` and `entrypoint-config.test.ts` |
| 5. Non-overlapping policy (SKIP) | ✅ | `worker.ts:34`: `overlap: ScheduleOverlapPolicy.SKIP`; tested in `worker.test.ts` |
| 6. Manual intake still works and stays contract-compatible | ✅ | `client.ts` unchanged; uses same `handleWorkflowTrigger` / `loadManualCandidate` |
| 7. Tests cover schedule create/update, default-enabled, disabled opt-out, workflow execution, idempotency | ✅ | `worker.test.ts` (3 tests), `pickup-workflow.test.ts` (2 workflow sandbox tests), `pickup.test.ts` (2 tests), `config.test.ts` (1 test), `entrypoint-config.test.ts` (multiple pickup-related tests) |
| 8. Webhook support explicitly out of scope | ✅ | No webhook/HTTP code added; README mentions scheduled pickup only |

**DoD gap:** "At least one fake-agent verification path exercises scheduled pickup-driven workflow start/resume behavior rather than only manual CLI pickup" — the e2e fake-agent harness (`e2e/src/run-e2e.ts`) only exercises the manual `loadManualCandidate → handleWorkflowTrigger` path. No e2e test starts a Temporal Schedule or invokes `pickupWorkflow` end-to-end.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

- **Missing e2e fake-agent pickup path (DoD violation).** The task-11 DoD requires "At least one fake-agent verification path exercises scheduled pickup-driven workflow start/resume behavior rather than only manual CLI pickup." The e2e harness (`e2e/src/run-e2e.ts`, `e2e/src/fake-agent.test.ts`) only covers the manual CLI intake path. Add an e2e test that either invokes `pickupWorkflow` directly via `client.workflow.execute(pickupWorkflow, ...)` with real fake-agent activities, or creates a schedule and verifies a pickup tick triggers workflow start/resume.

### Should Fix

- **`startPickupWorkflows` activity opens a Temporal Connection per invocation with no cancellation coordination** (`pickup-activities.ts:29-41`). The `finally` block closes the connection, which is correct for the happy path. However, if the activity is cancelled while `runPickupIntake` is mid-flight, the connection close races with in-progress gRPC calls. Consider either (a) caching the connection at worker startup and passing it through, or (b) documenting that the current per-invocation pattern is acceptable given the short-lived nature of pickup ticks.

- **Legacy cron workflow termination is fire-and-forget** (`worker.ts:99-105`). `stopLegacyPickupCronWorkflow` catches `WorkflowNotFoundError` but does not log the termination event. Add a `log.info` or `console.log` so operators know the migration happened. This is a one-time event but is otherwise invisible in production logs.

## Out-of-Scope Follow-Ups

- `createTemporalWorkflowTriggerDeps` (`intake.ts:179`) hardcodes `TASK_QUEUE` from `shared.ts` rather than accepting a configurable task queue. If the worker's `config.temporal.taskQueue` differs from the constant, child workflows started by `startPickupWorkflows` would be placed on the wrong queue. This is a pre-existing pattern (not introduced by task 11) and affects the manual CLI path equally.
- Webhook bridge/event ingestion remains explicitly deferred per task-11 scope.

## Rejected Noise

- `ScheduleHandle.trigger(overlap)` API usage — confirmed correct; the Temporal TS SDK accepts `ScheduleOverlapPolicy` directly as the first argument.
- `pickup.ts:runScheduledPickup` return type uses a complex `Extract<Awaited<ReturnType<...>>>` expression. This is verbose but type-safe and consistent with the intake contract. Not worth changing.
- `buildPickupScheduleOptions` uses template literal `\`${config.pickup.intervalSeconds}s\`` for the interval spec. This is the documented Temporal SDK format.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. **Add an e2e fake-agent test** that invokes `pickupWorkflow` (either directly or via a schedule) and verifies it triggers workflow start/resume through the fake-agent stack. This is the only blocker for DoD completion.
2. Optionally add a log line in `stopLegacyPickupCronWorkflow` for observability during migration.
