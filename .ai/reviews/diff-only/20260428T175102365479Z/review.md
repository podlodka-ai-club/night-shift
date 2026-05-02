# Review — Task 7 Deterministic Phases Migration

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` (`e6f3576..main`) with focus on Task 7 acceptance criteria: bounded review loop, review escalation/resume, unified `workflow:phase-failure` handling, escalation labels, and fake-agent rerun E2E proof. Inspected `workflows.ts`, all three phase modules (`specify/`, `implement/`, `review/`), workflow test files (`workflow-shell.test.ts`, `workflow-failure.test.ts`, `workflow-success.test.ts`, `review-phase.test.ts`), fake-agent harness (`fake-agent.ts`, `fake-agent.test.ts`), and run contract (`run-contract.ts`, `run-contract.test.ts`).

## Source Artifact

Task 7 spec: `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-7.md`. No external story/ticket artifact was supplied.

## Acceptance / Spec Coverage

All five acceptance criteria appear satisfied:

1. **AC1 — needs-fix loop**: `decideReviewVerdict` returns `needs-fix` when error findings exist before `maxReviewIterations`. The workflow increments `reviewIteration`, sets `currentPhase = 'implement'`, and loops. Tested in `workflow-shell.test.ts` ("loops implement-review on needs-fix").
2. **AC2 — escalation on final iteration**: `decideReviewVerdict` returns `escalate` on the final iteration. The review phase adds `night-shift:escalation` label, upserts `review:escalation` comment, and moves to Blocked. Tested in `review-phase.test.ts` ("adds the escalation label…") and `workflow-shell.test.ts` ("ignores stale resume signals…").
3. **AC3 — resume reruns implement**: The workflow blocks on `review_escalation`, waits for `resumeSignal`, resets `reviewIteration` to 0, re-enters implement. Tested in the escalation-resume test with 8 agent sequence calls.
4. **AC4 — unified phase-failure**: `handlePhaseFailure` in workflows.ts moves to Blocked and upserts a `workflow:phase-failure` comment naming the phase, root cause, and suggested action. Applied to all three phases. Tested in `workflow-failure.test.ts` and `workflow-shell.test.ts` ("upserts workflow:phase-failure…").
5. **AC5 — idempotent markers**: All phase-failure and escalation comments use marker-based `upsertIssueComment`, ensuring idempotency across retries.

## Previous Review Verification

No previous review was supplied. Verification was skipped.

## Findings

### Must Fix

_(none)_

### Should Fix

- **`ReviewPhaseContractError` uses manual `cause` assignment instead of `super(message, { cause })`** (`orchestrator/src/phases/review/errors.ts:3-8`). This was already noted in the Task 6 tech-debt entry but remains unfixed. `ImplementPhaseContractError` has the same pattern. Both should use the ES2022 `Error` cause mechanism (`super(message, { cause })`) for consistency and proper stack chain propagation.

- **`SpecifyPhaseContractError` discards `cause` entirely** (`orchestrator/src/phases/specify/errors.ts`). Unlike the other two phase errors, this constructor accepts no `cause` parameter. This means specify-phase contract failures lose their original error context. Add a `cause` parameter consistent with the other phase errors.

- **Duplicated `findErrorInCauseChain` / `describeErrorCauseChain` helper functions**. The same cause-chain walking logic appears in `workflows.ts`, `review/phase.ts`, `implement/phase.ts`, and `workflow-shell.test.ts`. Extract to a shared utility to reduce drift risk.

- **Live fake-agent E2E requires `E2E_TARGET_REPO` env var** — `make e2e-live-fake` fails immediately without it. The DoD says "the e2e harness passes in fake-agent mode for at least one scenario that exercises a review rerun or escalation path." The fake-agent *unit tests* (`fake-agent.test.ts`) do pass and cover review rerun determinism, and the run-contract tests cover the review-rerun status sequence. However, the live E2E cannot be verified without GitHub credentials/config. This is acceptable for offline CI but should be documented.

## Out-of-Scope Follow-Ups

- Board-driven automation for `Ready` / `In review` resume transitions (deferred to Task 8 per spec).
- `implementRetry` and `resume` signal handlers are now activated; board-level webhook dispatch to fire them remains Task 8.
- Worktree corruption recovery (Task 9).

## Rejected Noise

- The `maxReviewIterations` constant (3) is hardcoded rather than configurable — this is intentional for the current deterministic model and not a defect.
- `AssertionError` typo in test helper (`workflow-shell.test.ts:823`) — this is Node's actual `assert.AssertionError` class name, not a typo.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied beyond the in-repo task spec
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Align all three `*PhaseContractError` classes to use `super(message, { cause })` for proper ES2022 error chain support.
2. Extract the duplicated cause-chain helpers (`findErrorInCauseChain`, `describeErrorCauseChain`, `describeWorkflowError`) into a shared utility module.
3. Proceed to Task 8 (board-driven automation / webhook signal dispatch).
