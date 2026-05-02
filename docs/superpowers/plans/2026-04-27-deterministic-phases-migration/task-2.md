# Task 2 — Land the typed phase-runtime foundation on the current execution path

## Motivation

This task creates the reusable runtime substrate for deterministic phases without yet changing the full workflow shape. The functional value is that the current live path gains typed contracts, adapter isolation, and a shared structured-turn helper while preserving the current branch's retry-safe mechanics.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 2: Extract stable lower-level service boundaries from the current branch`
  - `Stage 3: Introduce phase-local contracts before changing workflow control flow`
  - `Stage 4: Add an adapter/session abstraction without changing the provider behavior`
  - `Stage 5: Introduce a shared structured-turn helper backed by current mechanics`
  - `Validation checkpoints -> After Stage 2`, `After Stage 3`, `After Stage 4`, `After Stage 5`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Structured output contract` sections for `Specify`, `Implement`, and `Review`
  - `What this means for the current branch rewrite -> Practical mapping`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- Internal ordering for this task is mandatory: extract seams -> define phase contracts -> freeze adapter boundary -> build shared structured-turn helper -> migrate one real current-path caller through it.

## Prerequisites

- Task 1 complete so regression guardrails and canonical status terminology are already in place.

## Target Code State

- The current branch exposes explicit lower-level seams for:
  - worktree lifecycle
  - GitHub/project/PR/comment operations
  - structured agent turns
- Phase-local contract modules for `Specify`, `Implement`, and `Review` exist before workflow control-flow migration depends on them.
- A provider-neutral `AgentAdapter` boundary exists and the current Codex integration is implemented behind it.
- A shared structured-turn helper owns:
  - `outputSchema` passthrough
  - checkpoint/resume thread handling
  - parse/validate/repair flow
  - progress events
- The current `Ready`-path execution uses the new adapter-backed helper for at least one real structured caller while preserving outward GitHub behavior.
- The old global schema-registry path is no longer the preferred design center for new work.

## Acceptance Criteria (AC)

1. The current `Ready`-path caller can run through the new adapter-backed structured-turn helper end-to-end without changing outward GitHub behavior.
2. Contract modules for `SpecifyResponse`, `ImplementResponse`, and `ReviewerResponse` reject malformed payloads with targeted unit tests.
3. Checkpoint/resume behavior is preserved through the new helper, including invalid-output repair behavior, thread/session identity continuity, and same-thread resume semantics.
4. Adapter parity tests show the Codex-backed runtime still supports thread identity, cancellation wiring, progress events, and structured output.
5. Deterministic contract failures at the parser/path-validation layer are classified separately from infrastructure/runtime failures in unit or integration tests.

## Definition of Done (DoD)

- New unit tests cover contract parsers, adapter behavior, and shared structured-turn helper behavior.
- Targeted runtime integration tests cover adapter/resume/output changes in addition to pure helper tests.
- Existing runtime tests for checkpointing and structured output still pass.
- Existing workflow success/failure tests remain green.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode with no regression to the current live path.
- Because this task changes the provider/runtime seam, one prescribed real-agent smoke run is required before task signoff in an environment with credentials. Minimum scenario: run one donor-compatible `Ready` item through the migrated real current-path caller and verify structured output plus the expected PR/comment/status side effects.

## Risks and Mitigations

- Risk: checkpoint/resume semantics regress while moving logic under a new helper.
  - Mitigation: port current checkpoint tests first and treat them as non-negotiable acceptance tests.
- Risk: the adapter surface bakes in Codex-specific assumptions.
  - Mitigation: freeze the adapter contract around turn inputs/outputs, thread identity, cancellation, and events before moving callers.
- Risk: phase-local contracts drift from donor behavior.
  - Mitigation: derive schemas and parser invariants directly from the workflow-reference document and donor branch tests where possible.
- Risk: this task collapses too much foundation work into one milestone and becomes hard to prove.
  - Mitigation: preserve the internal sub-order above and require one real current-path caller to migrate through the helper before the task is considered complete.