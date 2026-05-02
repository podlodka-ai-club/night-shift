# Task 5 — Port the Implement phase on top of the current git and PR mechanics

## Motivation

This task makes approved specs actionable under the new phased architecture. It preserves the current branch's strongest operational asset — retry-safe worktree, commit, push, and PR behavior — while replacing the old generic step engine with a phase-owned implementation contract.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 8: Port Implement second`
  - `What to keep from the current branch -> Cached clone + worktree ownership model`
  - `What to keep from the current branch -> Retry-safe git and PR mechanics`
  - `Validation checkpoints -> After Stage 8`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Phase 2: Implement`
  - `Quality gates`
  - `GitHub side effects` under Implement
  - `Workflow gating after Implement`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task ports Implement semantics on top of current git/worktree/PR mechanics; final cleanup-policy choices remain deferred to Task 9.

## Prerequisites

- Tasks 1 through 4 complete so board/status semantics, the phased shell, and the approved spec path already exist.

## Target Code State

- A dedicated `implement` phase module exists with local prompt/response/parse/error boundaries.
- From this task onward, `Ready` means an approved spec bundle is available for implementation. Legacy `Ready` items without an approved spec bundle are rejected explicitly and redirected back toward the Specify path instead of triggering a best-effort implementation attempt.
- The phase reads the approved spec bundle from `openspec/changes/<changeName>` and turns it into an implementation prompt.
- File writing, commit, push, and PR creation continue to flow through the current branch's proven worktree and GitHub activity modules.
- Quality-gate execution is phase-owned and produces typed retry feedback rather than relying on generic sequence metadata.
- The same per-ticket branch/worktree is reused across `implementRetry` and later review-loop reruns unless an explicit later policy change supersedes that behavior.
- Deterministic payload/path-validation failures are classified separately from infrastructure/runtime failures.
- Donor preserve-on-failure behavior is not adopted as a default policy in this task; cleanup/preservation policy remains provisional until Task 9.
- The workflow path `Ready -> In progress -> In review` now runs through the new Implement phase and returns either `pr_opened` or `needs_input`.

## Acceptance Criteria (AC)

1. Entering the Implement phase from `Ready` moves the item to `In progress`, reads the spec bundle, writes the returned files into the worktree, and commits using the phase-owned `commitMessage`.
2. When configured quality gates pass, the phase pushes the branch, opens or updates the implementation PR, upserts `implement:summary`, and moves the item to `In review`.
3. When quality gates fail after retry, the phase upserts `implement:summary`, moves the item to `Blocked`, and blocks the workflow on `implement_needs_input`.
4. A fail-once / retry-with-feedback / succeed-on-second-attempt path proves the phase feeds typed retry context back into the next prompt.
5. Existing retry-safe behaviors remain intact, including retry after a local commit, retry after push but before PR/comment/status updates, and duplicate-PR recovery.
6. Direct workflow signal tests prove `implementRetry` unblocks only the Implement gate; board-driven automation for `Ready` transitions remains deferred to Task 8.
7. Legacy `Ready` items without an approved spec bundle fail explicit entry validation, surface operator guidance to send the item back through Specify, and never enter a best-effort implementation path.

## Definition of Done (DoD)

- Unit tests cover Implement contract parsing, file-path validation, quality-gate retry feedback, and prompt rendering from a spec bundle.
- Existing worktree and GitHub PR tests still pass, plus new phase-specific tests for `pr_opened` vs `needs_input`.
- Workflow tests cover `implementRetry` gating, worktree reuse across retries, and partial-existing worktree recovery.
- Targeted retry-injection tests cover dangerous side-effect windows around commit/push/PR/comment/status updates.
- Entry-validation tests cover the legacy `Ready`-without-spec-bundle bootstrap case.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode for a `Ready`-started ticket through PR creation.

## Risks and Mitigations

- Risk: refactoring to phase-owned contracts breaks duplicate PR recovery or retry-safe push behavior.
  - Mitigation: keep those mechanics in their current modules and treat their existing tests as regression gates.
- Risk: spec-bundle parsing becomes too tightly coupled to current file layout.
  - Mitigation: keep a single spec-bundle loader boundary and test it with representative change-folder fixtures.
- Risk: quality gates slow the task down or become flaky in tests.
  - Mitigation: separate pure result parsing from command execution and keep workflow tests focused on mocked gate outcomes.
- Risk: provisional cleanup behavior accidentally drifts toward the donor branch's preserve-on-failure policy before an explicit decision is made.
  - Mitigation: state in code/tests that cleanup policy remains provisional here and defer steady-state cleanup semantics to Task 9.