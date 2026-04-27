# Task 8 — Add webhook-bridge and pickup automation for phased execution

## Motivation

This task makes the new deterministic workflow operational in day-to-day use. Instead of requiring manual starts and custom signaling, the board itself becomes the control surface for starting and unblocking phased workflows.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 10: Add webhook bridge and pickup model`
  - `What to borrow from the milestone branch -> Webhook + pickup trigger model`
  - `Validation checkpoints -> After Stage 10`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Trigger model: webhook + pickup + manual start`
  - `Webhook / board transition behavior`
  - `Pickup behavior`
  - `Project board lookup behavior`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task is the first one that makes board transitions operationally start/signal workflows instead of only being modeled in workflow tests.

## Prerequisites

- Tasks 3 through 7 complete so phase semantics, blocked reasons, and signal handling are already stable.

## Target Code State

- A trigger-handling layer exists that translates board status transitions into either:
  - workflow start
  - workflow signal
  - no-op
- Webhook handling and scheduled pickup share the same trigger-resolution logic so the contract lives in one place.
- Pickup scans `Backlog` and `Ready`, tags items with the correct `startPhase`, sorts by `createdAt`, and starts/signals up to the configured cap.
- Manual-start tooling, if retained, delegates to the same handler rather than bypassing workflow rules.

## Acceptance Criteria (AC)

1. `Backlog` items with no workflow start in `specify` mode.
2. `Ready` items with no workflow start in `implement` mode.
3. `Backlog`, `Ready`, and `In review` transitions signal blocked workflows exactly as defined by the copied transition contract.
4. Pickup merges `Backlog` and `Ready` candidates, sorts by `createdAt`, and respects the per-tick cap for both starts and signals.
5. Trigger-resolution tests cover start vs signal vs no-op, blocked-reason mismatch, duplicate webhook delivery, and closed/prior-run restart behavior.
6. Race tests cover webhook and pickup observing the same item and prove the workflow is started/signaled idempotently rather than duplicated.

## Definition of Done (DoD)

- Unit tests cover the trigger table and pickup candidate ordering.
- Workflow-level tests prove blocked workflows are signaled rather than duplicated and that stale/unsupported transitions become no-ops.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode using board-driven start/resume behavior rather than a purely manual trigger.

## Risks and Mitigations

- Risk: duplicate workflow starts occur when webhook and pickup observe the same item.
  - Mitigation: centralize trigger resolution and make start-vs-signal behavior idempotent and test-driven.
- Risk: project-item lookup or pagination causes stale ordering.
  - Mitigation: preserve donor-style `createdAt` sorting and test pagination/multi-item scenarios.
- Risk: automation is added before blocked-state semantics are stable.
  - Mitigation: only land this task after Tasks 3 through 7 are green and covered by workflow tests.