# Task 8 — Add pickup/manual intake automation for phased execution

## Motivation

This task makes the new deterministic workflow operational in day-to-day use without adding webhook infrastructure. The remaining intake surface should come from scheduled pickup plus any retained manual-start tooling, with both paths honoring the same phased start/signal rules.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 10: Add webhook bridge and pickup model`
  - `What to borrow from the milestone branch -> Webhook + pickup trigger model` (pickup/start-signal semantics only; webhook support excluded)
  - `Validation checkpoints -> After Stage 10`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Trigger model: webhook + pickup + manual start` (use pickup/manual portions only)
  - `Pickup behavior`
  - `Project board lookup behavior`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task is the first one that makes non-webhook intake operationally start/signal workflows instead of only being modeled in workflow tests.
- Webhook delivery/bridge support is explicitly out of scope for this migration and should not be implemented here.

## Prerequisites

- Tasks 3 through 7 complete so phase semantics, blocked reasons, and signal handling are already stable.

## Target Code State

- A trigger-handling layer exists that translates pickup/manual intake decisions into either:
  - workflow start
  - workflow signal
  - no-op
- Scheduled pickup and any retained manual-start tooling share the same trigger-resolution logic so the contract lives in one place.
- Pickup scans `Backlog` and `Ready`, tags items with the correct `startPhase`, sorts by `createdAt`, and starts/signals up to the configured cap.
- Manual-start tooling, if retained, delegates to the same handler rather than bypassing workflow rules.
- No webhook bridge, webhook event ingestion, or board-transition listener is added in this task.

## Acceptance Criteria (AC)

1. `Backlog` items with no workflow start are started in `specify` mode via pickup/manual intake.
2. `Ready` items with no workflow start are started in `implement` mode via pickup/manual intake.
3. Intake decisions for `Backlog`, `Ready`, and `In review` signal blocked workflows exactly as defined by the copied transition contract.
4. Pickup merges `Backlog` and `Ready` candidates, sorts by `createdAt`, and respects the per-tick cap for both starts and signals.
5. Trigger-resolution tests cover start vs signal vs no-op, blocked-reason mismatch, duplicate pickup/manual intake, and closed/prior-run restart behavior.
6. Idempotency tests cover repeated pickup ticks and/or manual retries observing the same item and prove the workflow is started/signaled safely rather than duplicated.
7. Tests/documentation make it explicit that webhook support is out of scope and not required for task completion.

## Definition of Done (DoD)

- Unit tests cover the intake trigger table and pickup candidate ordering.
- Workflow-level tests prove blocked workflows are signaled rather than duplicated and that stale/unsupported pickup/manual intake decisions become no-ops.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode using pickup/manual intake-driven start/resume behavior rather than a purely test-only direct trigger.

## Risks and Mitigations

- Risk: duplicate workflow starts occur when pickup repeats or manual intake races with an already-started workflow.
  - Mitigation: centralize trigger resolution and make start-vs-signal behavior idempotent and test-driven.
- Risk: project-item lookup or pagination causes stale ordering.
  - Mitigation: preserve donor-style `createdAt` sorting and test pagination/multi-item scenarios.
- Risk: webhook behavior is accidentally introduced as part of intake work.
  - Mitigation: keep webhook support explicitly out of scope in code, tests, and docs for this task.
- Risk: automation is added before blocked-state semantics are stable.
  - Mitigation: only land this task after Tasks 3 through 7 are green and covered by workflow tests.