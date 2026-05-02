# Task 7 — Add the review fix loop, escalation handling, and unified phase-failure UX

## Motivation

This task completes the deterministic workflow model by adding bounded review iterations, implement/review reruns, and human escalation recovery. It also aligns all phase failures with donor-style blocked comments and operator guidance.

## References

- `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `Stage 9: Port Review third`
  - `What to borrow from the milestone branch -> Dashboard and operator-facing blocking semantics`
  - `What to borrow from the milestone branch -> Phase-specific error classification`
  - `Risks and mitigations -> Risk 1`, `Risk 2`
- `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`
  - `Verdict rule`
  - `GitHub side effects by verdict -> needs-fix`, `escalate`
  - `Workflow behavior after Review`
  - `Failure handling across all phases`

## Execution Baseline

- Implementation base snapshot: current branch `c03e1cc617ede27c0ad3337671f324e5ffa4629a` (`c03e1cc`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- This task extends review/workflow semantics; live board-transition automation remains deferred to Task 8.

## Prerequisites

- Tasks 4 through 6 complete so Specify, Implement, and the Review happy path are already working.

## Target Code State

- Review iterations are tracked explicitly in workflow state and surfaced in current-details/dashboard output.
- A `needs-fix` verdict routes the workflow back through Implement and then into the next Review iteration until `maxReviewIterations` is reached.
- An `escalate` verdict blocks the workflow with `review_escalation` and waits for `resume`.
- A thrown phase failure still uses the phase-failure path: set status to `Blocked`, upsert the phase-failure comment, and end the attempt instead of entering `review_escalation`.
- Unified phase-failure handling exists across `Specify`, `Implement`, and `Review`, including marker-upserted issue comments with suggested next steps.
- Resume behavior from `Ready` or `In review` re-enters the workflow exactly as described by the copied transition contract.

## Acceptance Criteria (AC)

1. Error findings before the final iteration produce `needs-fix`, move the item to `Ready`, and rerun `Implement -> Review` on the next attempt.
2. Error findings on the final allowed iteration produce `escalate`, add the escalation label/comment artifacts, move the item to `Blocked`, and block the workflow on `review_escalation`.
3. Direct workflow signal tests prove `resume` reruns Implement, restarts the review loop at iteration `0`, and preserves prior timeline/history details; board-driven automation for `Ready` or `In review` transitions is still deferred to Task 8.
4. Any thrown phase failure creates a single marker-upserted issue comment that names the failed phase, root cause, and suggested next action, and it ends the attempt rather than entering `review_escalation`.
5. Retry-injection tests prove escalation labels/comments and phase-failure comments remain idempotent across retries.

## Definition of Done (DoD)

- Workflow tests cover bounded iteration count, `needs-fix` loops, escalation, resume, and stale resume signals.
- GitHub-side-effect tests cover escalation labels/comments and unified phase-failure comments.
- Table-driven tests cover allowed vs stale resume behavior and keep `review_escalation` distinct from thrown phase failures.
- `make check` passes from the repository root.
- The `e2e` harness passes in `fake-agent` mode for at least one scenario that exercises a review rerun or escalation path.

## Risks and Mitigations

- Risk: loop control bugs cause infinite reruns or skipped review iterations.
  - Mitigation: keep review iteration state explicit and cover the upper bound in workflow tests.
- Risk: resume semantics become ambiguous between `Ready` and `In review` entry points.
  - Mitigation: encode the copied transition contract as table-driven tests for board-state to signal behavior.
- Risk: failure comments duplicate across retries.
  - Mitigation: require marker-based upserts for all phase-failure comments from the outset.
- Risk: review escalation semantics drift into a catch-all for thrown failures.
  - Mitigation: keep verdict-driven escalation and thrown phase-failure handling as separate tested paths.