# Task 11 — Add donor-style scheduled pickup workflow

## Motivation

This task closes the biggest remaining donor-branch automation gap without expanding scope into webhook ingestion. The current branch already has shared intake semantics for pickup/manual triggering; this task makes pickup operational in the donor style by running it on a Temporal Schedule, enabled by default, so `Backlog` and `Ready` work can be started/resumed automatically without external cron or manual CLI intervention.

## References

- Current branch
  - `orchestrator/src/intake.ts`
  - `orchestrator/src/client.ts`
  - `orchestrator/src/worker.ts`
  - `orchestrator/src/workflows.ts`
  - `orchestrator/src/config.ts`
  - `orchestrator/src/entrypoint-config.ts`
- Architecture donor branch (`remotes/origin/milestone-1-deterministic-phases`)
  - `src/orchestration/pickup-workflow.ts`
  - `src/orchestration/worker.ts`
  - `src/orchestration/pickup-activities.ts`
  - `src/orchestration/__test__/pickup-workflow.test.ts`
  - `src/orchestration/__test__/pickup-schedule.e2e.test.ts`

## Execution Baseline

- Implementation base snapshot: current branch `96609d330f47ad9588a8c925b6e29caf0708cb09` (`96609d3`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- Tasks 1 through 10 are already complete; this task is a follow-up automation slice that should reuse the existing shared intake contract instead of re-inventing trigger semantics.
- Webhook delivery/bridge support remains explicitly out of scope for this task and should not be added here.

## Prerequisites

- Task 8 complete and green, because scheduled pickup must reuse the existing intake layer rather than fork it.
- Task 10 complete and green, because worker/client config loading is now the supported place to hang any pickup schedule settings.

## Target Code State

- A dedicated Temporal pickup workflow exists in the current branch, following the donor model closely enough that scheduled pickup orchestration lives in Temporal rather than a worker-side timer loop or external cron wrapper.
- The scheduled pickup workflow reuses the current branch's intake semantics (`loadPickupCandidates`, `runPickupIntake`, `handleWorkflowTrigger`) rather than duplicating start/signal/no-op rules.
- Worker startup ensures the pickup schedule exists and updates it idempotently when configuration changes.
- Scheduled pickup is enabled by default; configuration may opt out explicitly, but the default runtime behavior should create/use the pickup schedule.
- The pickup schedule uses a stable schedule id and overlap policy that avoids concurrent duplicate pickup ticks.
- Manual CLI intake remains supported and continues to share the same intake contract; this task should not regress or bypass the current manual intake path.
- No webhook event ingestion, HTTP server, or board-transition listener is added in this task.

## Acceptance Criteria (AC)

1. A dedicated scheduled pickup workflow exists and can be started by a Temporal Schedule in the current orchestrator runtime.
2. Worker startup creates or updates the pickup schedule idempotently using a stable schedule id, and repeated worker boots do not create duplicate schedules.
3. Scheduled pickup reuses the existing intake semantics for candidate ordering and start/signal/no-op trigger resolution instead of implementing a second trigger table.
4. Pickup scheduling is enabled by default; an explicit config override can disable it, but the default resolved config enables scheduled pickup.
5. The schedule uses a non-overlapping policy (for example `SKIP`) so duplicate concurrent pickup ticks are avoided.
6. Existing manual intake (`client.ts`) still works and stays contract-compatible with scheduled pickup.
7. Tests cover schedule creation/update behavior, default-enabled pickup config, disabled opt-out behavior, scheduled pickup workflow execution, and repeated-tick idempotency expectations.
8. Tests/documentation keep webhook support explicitly out of scope for task completion.

## Definition of Done (DoD)

- Focused tests cover the new pickup workflow and worker-side schedule bootstrap/update behavior.
- Existing intake tests remain green and prove the scheduled path still relies on the shared intake contract.
- `make check` passes from the repository root.
- Documentation explains that scheduled pickup is enabled by default, how to disable or tune it, and that webhook support is still deferred.
- At least one fake-agent verification path exercises scheduled pickup-driven workflow start/resume behavior rather than only manual CLI pickup.

## Risks and Mitigations

- Risk: scheduled pickup re-implements trigger semantics and drifts from manual intake.
  - Mitigation: route the scheduled path through the existing intake helpers and extend tests around the shared seams instead of adding a parallel ruleset.
- Risk: worker startup creates duplicate schedules or leaves stale schedule configuration behind.
  - Mitigation: use a stable schedule id, idempotent create-or-update logic, and explicit tests for repeated startup.
- Risk: enabling pickup by default surprises local development environments.
  - Mitigation: keep defaults conservative (bounded interval/cap), document opt-out clearly, and preserve manual CLI control for local debugging.
- Risk: this task accidentally expands into webhook infrastructure.
  - Mitigation: keep webhook support explicitly out of scope in code, tests, and docs for this task.