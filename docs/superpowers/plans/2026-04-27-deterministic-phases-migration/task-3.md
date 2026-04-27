# Task 3 — Install the phased Temporal shell and implement-start entrypoint

## Motivation

This task introduces the deterministic orchestration container before all phase logic is ported. Functionally, it upgrades the current branch from a one-shot workflow to a state machine with explicit phase state, signals, blocked reasons, and operator-visible dashboard details.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 6: Reshape the current Temporal workflow shell in place`
  - `Keep / Rewrite / Borrow / Drop map`
  - `Validation checkpoints -> After Stage 6`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Top-level workflow model`
  - `Workflow identity and inputs`
  - `Blocking reasons used by the workflow`
  - `Signals used by the workflow`
  - `Query used by the workflow`
  - `Dashboard / observability model`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task ports workflow-shell semantics only; board-transition automation remains deferred to Task 8.

## Prerequisites

- Tasks 1 and 2 complete so the runtime/helper seams and baseline regression guards already exist.

## Target Code State

- `orchestrator/src/workflows.ts` becomes a phased workflow shell rather than a single linear `Ready issue -> PR` procedure.
- The workflow state explicitly tracks:
  - current phase
  - blocked reason
  - start phase (`specify` or `implement`)
  - review iteration metadata
  - dashboard/current-details content
- Signals exist for `specifyRetry`, `specReviewed`, `implementRetry`, `resume`, and `activityProgress`.
- A `getBlockedReason` query exists and is exercised by tests.
- The initial functional slice of the phased shell supports starting directly at `implement` for `Ready` items while still delegating to the current operational mechanics under the hood.
- Signal and query behavior is directly testable via workflow handles even before webhook/pickup automation exists.

## Acceptance Criteria (AC)

1. A workflow can be started in `implement` mode and complete the current `Ready -> In review` happy path through the new phased shell.
2. Workflow tests cover blocked-reason/query behavior, at least one blocked/resume-style roundtrip through the new signal plumbing, stale-signal handling, and dashboard/current-details rendering.
3. The worker/client wiring is updated so the new workflow inputs and queries are reachable from tests and future trigger paths.
4. The phased shell does not yet require `Specify` or `Review` parity to remain functional for `Ready`-item automation.

## Definition of Done (DoD)

- Unit/workflow tests cover phase-state transitions, query results, and current-details output.
- Existing failure-path tests still pass after the shell rewrite.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode for the `Ready`-entry path through the new workflow shell.

## Risks and Mitigations

- Risk: deterministic workflow state becomes entangled with activity-local details.
  - Mitigation: keep workflow state small and phase result objects explicit; push all non-deterministic work into activities/helpers.
- Risk: signal behavior is added but not actually consumed by any testable path.
  - Mitigation: require at least one blocked/resume-style unit test even before full `Specify` and `Review` are ported.
- Risk: current live path regresses during shell replacement.
  - Mitigation: keep the implement-start happy path working end-to-end and use it as the minimum E2E contract for this task.