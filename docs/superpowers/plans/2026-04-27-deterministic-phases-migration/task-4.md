# Task 4 — Port the Specify phase and human spec-review gate

## Motivation

This task delivers the first new product behavior the current branch does not have: human-in-the-loop spec generation and approval. It turns `Backlog` issues into OpenSpec change folders plus draft spec PRs, and it introduces the first explicit workflow gate.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 7: Port Specify first`
  - `What to borrow from the milestone branch -> Deterministic phase/state-machine workflow`
  - `What to borrow from the milestone branch -> Phase-local prompt/response/parse/error modules`
  - `What to borrow from the milestone branch -> Dashboard and operator-facing blocking semantics`
  - `Validation checkpoints -> After Stage 7`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Phase 1: Specify`
  - `GitHub side effects` under Specify
  - `Workflow gating after Specify`
  - `Exact GitHub issue / PR handling patterns`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task ports workflow and signal semantics for Specify; live board-transition automation remains deferred to Task 8.

## Prerequisites

- Tasks 1 through 3 complete so the phased shell, helper/runtime seams, and canonical board model already exist.

## Target Code State

- A dedicated `specify` phase module exists with local `prompt`, `response`, `parse`, `errors`, and `phase` boundaries.
- The phase reads issue context plus prior operator comments, filters prior Night Shift markers, and loads existing draft files under `openspec/changes/<changeName>`.
- The phase uses the new adapter-backed structured-turn helper and writes returned files under the donor-compatible OpenSpec change-folder structure.
- GitHub side effects include:
  - draft spec PR creation/update using donor-compatible title/body conventions
  - marker-upserted `specify:summary` issue comments using donor-compatible summary behavior
  - status transitions to `Refinement`, `Refined`, or `Blocked`
- Validator failure is retried once with donor-style validation feedback appended to the prompt, and deterministic contract failures are classified separately from infrastructure/runtime failures.
- The workflow now supports a `Backlog -> Specify -> awaiting_spec_review/specify_needs_input` path and waits for `specReviewed` or `specifyRetry` as defined by the copied contract.

## Acceptance Criteria (AC)

1. Starting a ticket in `Backlog` runs `Specify`, moves the item to `Refinement`, and writes/updates `openspec/changes/<changeName>` contents.
2. A successful spec with no open questions opens or updates a draft spec PR, upserts the `specify:summary` issue comment, moves the item to `Refined`, and blocks on `awaiting_spec_review`.
3. A spec with validator failure or unresolved open questions upserts `specify:summary`, moves the item to `Blocked`, and blocks on `specify_needs_input`.
4. Direct workflow signal tests prove `specReviewed` and `specifyRetry` unblock the correct gates; live board-transition automation for those moves is still deferred to Task 8.
5. Phase-level tests cover invalid structured output -> repair -> success and deterministic invalid payload/path failures -> non-retryable failure classification without duplicate GitHub side effects.

## Definition of Done (DoD)

- Unit tests cover Specify prompt rendering, schema/parser invariants, validator-retry behavior, and donor-required file-path rules.
- Workflow tests cover both `awaiting_spec_review` and `specify_needs_input` gates.
- GitHub-side-effect tests cover draft spec PR creation/update and marker comment upserts.
- Targeted runtime integration tests prove same-thread resume/repair behavior is still correct when wrapped by the Specify phase.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode for a `Backlog`-started ticket through the Specify gate.

## Risks and Mitigations

- Risk: OpenSpec file layout or validator behavior diverges from donor expectations.
  - Mitigation: treat `proposal.md`, `tasks.md`, optional `design.md`, and `specs/<capability>/spec.md` path rules as contract tests.
- Risk: issue comments become noisy or non-idempotent.
  - Mitigation: adopt marker-upsert behavior in the same task and add filtering tests for later operator-context reads.
- Risk: spec-review gating introduces dead states on the board.
  - Mitigation: encode the copied status/signal matrix as workflow tests before wiring webhook/pickup automation.