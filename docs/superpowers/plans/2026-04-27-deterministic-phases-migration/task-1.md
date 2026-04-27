# Task 1 — Normalize the board model and lock in regression guardrails

## Motivation

This task makes the GitHub Project speak the donor workflow's status language before any phase migration begins. Functionally, it enables later `Specify -> Implement -> Review` transitions to be represented on the real board without compatibility shims, while also preserving the current branch as a safe regression baseline.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 0: Freeze the baseline and expand regression coverage`
  - `Stage 1: Normalize the project board to the referenced branch's status model`
  - `What to keep from the current branch -> Live GitHub E2E harness`
  - `Validation checkpoints -> After Stage 1`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Canonical GitHub board statuses`
  - `Blocking reasons used by the workflow`
  - `Signals used by the workflow`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- If current and donor behavior differ, default to the keep/borrow rules in the migration map.

## Prerequisites

- None beyond the pinned migration-map and workflow-reference documents.

## Target Code State

- A dedicated project-status management seam exists in the current branch's GitHub integration layer.
- Canonical status names and copied blocked-reason/signal mappings are defined once and reused by workflow tests, GitHub helpers, and E2E assertions.
- The current `Ready -> In progress -> In review` flow still works unchanged, but it now runs against the donor-compatible status vocabulary.
- Regression coverage is tightened around:
  - worktree reuse/cleanup
  - retry-safe PR creation
  - structured-output checkpoint/resume behavior
  - fake-agent live E2E status assertions

## Acceptance Criteria (AC)

1. The orchestrator can verify or create these project status options idempotently: `Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `In review`, `Ready to merge`, `Blocked`.
2. A shared helper, fixture set, or table-driven test proves each copied blocked-reason / board-status / signal mapping and is consumable by later workflow and trigger tests instead of existing only as documentation.
3. Existing current-branch workflow behavior for `Ready` items remains green after the status-model change.
4. Fake-agent E2E assertions are updated so they tolerate the richer board lifecycle without breaking the current path.

## Definition of Done (DoD)

- Unit tests cover status-option lookup/creation and any pure contract-mapping helpers.
- Table-driven tests prove the copied transition contract is executable test data, not just a fixture blob.
- Existing worktree, GitHub activity, workflow success/failure, and checkpoint tests still pass.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode.
- Any manual/bootstrap command needed to normalize the board is documented next to the plan or implementation docs.

## Risks and Mitigations

- Risk: breaking selection of the current top `Ready` item while adding new statuses.
  - Mitigation: keep `Ready` semantics intact and add regression tests around project-item selection.
- Risk: status creation logic becomes entangled with runtime workflow code.
  - Mitigation: isolate status-option management behind a small GitHub/project helper that can be reused by webhook/pickup later.
- Risk: E2E assertions become flaky because they assume a narrower status set.
  - Mitigation: update E2E polling/assertion helpers in the same task and keep fake-agent mode as the minimum required validation run.