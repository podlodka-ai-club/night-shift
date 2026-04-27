# Task 6 — Port the Review phase for the ready-to-merge happy path

## Motivation

This task adds automated review as a first-class phase instead of treating PR creation as the end of the workflow. The first slice focuses on the happy path so the system can reach `Ready to merge` with donor-style review summaries, findings, and dashboard output.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 9: Port Review third`
  - `What to borrow from the milestone branch -> Rich domain contracts`
  - `What to borrow from the milestone branch -> Phase-specific error classification`
  - `Validation checkpoints -> After Stage 9`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Phase 3: Review`
  - `Verdict rule`
  - `GitHub side effects by verdict -> ready-to-merge`
  - `Dashboard / observability model`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task covers only the `ready-to-merge` happy path; `needs-fix` and `escalate` remain intentionally deferred to Task 7.

## Prerequisites

- Tasks 1 through 5 complete so Implement already produces the donor-compatible PR and spec-bundle inputs Review depends on.

## Target Code State

- A dedicated `review` phase module exists with local prompt, response, parse, verdict, and error-classification boundaries.
- The phase gathers the spec bundle at the PR head SHA, the PR diff, changed files, and prior review comments, then runs the reviewer through the shared structured-turn helper.
- Review results are modeled as typed findings with severity and optional location/spec reference.
- GitHub review helpers can:
  - mark draft PRs ready when appropriate
  - upsert review summary comments
  - upsert inline review comments when locations are resolvable
  - upsert `review:summary` issue comments
- A clean review run moves the item to `Ready to merge` and ends the workflow successfully.

## Acceptance Criteria (AC)

1. An `In review` item with no error findings produces a `ready-to-merge` verdict and transitions the project item to `Ready to merge`.
2. The phase creates or updates the expected review summary artifacts without duplicating markers across retries.
3. Warning-only findings do not block the happy path.
4. Review contract failures are classified separately from infrastructure/runtime failures so deterministic bad output does not trigger useless retries.
5. Tests cover inline review comment creation when locations are resolvable and donor-style fallback behavior when `APPROVE` cannot be submitted due to self-review or API restrictions.

## Definition of Done (DoD)

- Unit tests cover Review response parsing, verdict calculation, and error classification.
- GitHub-side-effect tests cover review summary upserts, inline comment mapping, and `Ready to merge` transitions.
- Workflow tests cover the `In review -> Ready to merge` success path.
- Targeted runtime integration tests cover invalid structured output -> repair -> success at the phase wrapper, not just inside the shared helper.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode through a full happy path ending at `Ready to merge`.
- Task completion does not imply `needs-fix` or `escalate` parity; those behaviors remain part of Task 7.

## Risks and Mitigations

- Risk: self-review restrictions or API quirks prevent `APPROVE` submissions.
  - Mitigation: preserve donor-style fallback behavior to plain comments and cover both branches in GitHub-side-effect tests.
- Risk: diff truncation or changed-file mapping causes poor reviewer context.
  - Mitigation: keep explicit truncation rules and test both small-diff and truncated-diff prompt rendering.
- Risk: inline comment locations drift from actual changed lines.
  - Mitigation: treat inline comments as best-effort, but require stable fallback summary behavior.