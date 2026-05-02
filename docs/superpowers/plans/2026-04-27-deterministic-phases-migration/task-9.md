# Task 9 — Finalize post-parity operational policies and cleanup semantics

## Motivation

This task converts the hybrid migration into an explicit long-term operating model. Once functional parity is proven, the remaining policy decisions around push safety, cleanup retention, and status-management behavior should be made deliberately instead of remaining accidental leftovers from either source branch.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 11: Revisit policy choices after parity`
  - `What should NOT be copied as-is`
  - `Risks and mitigations -> Risk 3`, `Risk 4`, `Risk 5`
  - `Final migration decision -> Core strategy`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Current-branch mechanics that already exist and should likely be preserved`
  - `Short takeaway`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task resolves remaining policy choices only after Tasks 1 through 8 have already proven behavior parity.

## Prerequisites

- Tasks 1 through 8 complete and passing, with parity already demonstrated for the phased workflow and trigger model.

## Target Code State

- The production default behavior for branch pushing is explicit and documented, including whether any `--force-with-lease` policy is adopted.
- Cleanup semantics are explicit for:
  - success-path worktree cleanup
  - failure-path preservation for debugging
  - E2E cleanup vs preserve-on-failure behavior
- Any richer GitHub status-management semantics that survived the migration are codified in helpers/tests rather than living in workflow branches.
- Documentation reflects the final hybrid architecture: current branch operational mechanics underneath donor-style deterministic phases.

## Acceptance Criteria (AC)

1. The chosen push policy is implemented, documented, and covered by targeted tests for retry/idempotency expectations.
2. Success-path cleanup and exceptional failure preservation are both tested explicitly.
3. Transitional migration shims are resolved explicitly: any remaining compatibility path around the old schema-registry-driven flow, provisional cleanup branching from Task 5, or temporary trigger/start indirection is either removed or documented as an intentional steady-state seam.
4. The fake-agent live E2E path remains green after the final policy decisions are applied.

## Definition of Done (DoD)

- Targeted tests cover the selected push/cleanup/status policies.
- Legacy compatibility branches that are no longer needed are removed or clearly marked as intentional.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode.
- One prescribed real-agent smoke run is required before final migration signoff in an environment with credentials. Minimum scenario: execute the smallest live ticket path that exercises the latest provider/runtime seam changes—at minimum the real-agent implement-start path, and if phased runtime behavior changed after Task 2, the smallest full phased path affected.
- Final docs are updated to describe the steady-state architecture and operational defaults.

## Risks and Mitigations

- Risk: adopting more aggressive push behavior reintroduces git hazards that the current branch avoided.
  - Mitigation: make the choice explicit, test the unhappy paths, and prefer the safer existing behavior unless evidence supports changing it.
- Risk: cleanup policy swings too far toward deletion or preservation.
  - Mitigation: keep success-path and failure-path behavior separately configurable/tested and align them with E2E cleanup controls.
- Risk: the repo is left with migration-era abstractions that obscure the final design.
  - Mitigation: use this task to delete or consolidate temporary shims once parity is already proven.