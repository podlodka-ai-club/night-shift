# Task 5 AI Review Artifact

## Scope

Task 5 from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-5.md`:
- port the real Implement phase on top of the current worktree/git/PR mechanics
- require an approved spec bundle for `Ready` entry
- own quality-gate retry feedback and `implement_needs_input` blocking
- preserve retry-safe commit/push/PR/comment/status behavior
- prove the fake-agent harness can drive a `Ready` ticket through PR creation

## Review pass 1

Initial review found two material follow-ups:
- `e2e/src/run-e2e.ts` had regressed `live:real` to start at `implement`, which would block without a seeded approved spec bundle
- Task 5 still needed stronger retry-window proof around post-push PR/comment/status side effects

## Review pass 2

After those fixes, a second review found one material failure-classification gap:
- repair-exhausted structured-output failures were not yet preserved cleanly as non-retryable `AgentContractError`s across the activity boundary
- the Implement phase still had an overly broad `/invalid/i` fallback that could misclassify unrelated runtime failures

## Review pass 3

Follow-up fixes landed:
- `resolveStartPhase(...)` now keeps `live:fake` on Implement while restoring `live:real` to Specify
- workflow success tests now pin retry-safe PR/comment/status windows after push
- `activity-agent-sequence.ts` now rethrows repair-exhausted schema failures as non-retryable `AgentContractError` `ApplicationFailure`s
- `orchestrator/src/phases/implement/phase.ts` now narrows `/invalid/` handling to local Implement-payload parsing instead of any runtime error
- new tests prove runtime failures containing `invalid` still rethrow and do not route to `implement_needs_input`

## Review pass 4 (`review-code`)

Per the requested review flow, the final `review-code` pass found one should-fix:
- `ImplementPhaseContractError` should preserve its original `cause`

That follow-up was fixed by storing the original error on `ImplementPhaseContractError.cause`, rerunning the focused Implement tests, rerunning `make check`, and rerunning `review-code`.

Final verdict: **reviewer-happy / no material findings remain**.

Reviewer confirmation:
- AC1 satisfied: `Ready` entry moves to `In progress`, reads the approved spec bundle, writes repo files, and commits with the phase-owned commit message
- AC2 satisfied: passing quality gates push the branch, open/update the PR, upsert `implement:summary`, and move to `In review`
- AC3 satisfied: missing bundle / exhausted gate-retry paths upsert operator-visible `implement:summary`, move to `Blocked`, and block on `implement_needs_input`
- AC4 satisfied: gate-retry feedback is fed back into the next prompt and pinned by phase tests
- AC5 satisfied: retry-safe commit/push/PR/comment/status windows are pinned by workflow/activity regression tests
- AC6 satisfied: workflow tests prove `implementRetry` only unblocks the Implement gate and reuses the same selected Ready issue/worktree
- AC7 satisfied: legacy `Ready` items without an approved spec bundle are rejected explicitly with operator guidance and no best-effort implementation path

## Validation evidence

Successful local verification:
- `npm --workspace orchestrator exec -- mocha --exit --require ts-node/register --require source-map-support/register src/mocha/activity-agent-sequence-runtime.test.ts src/mocha/implement-phase.test.ts src/mocha/workflow-shell.test.ts src/mocha/workflow-success.test.ts`
- `npm --workspace e2e exec -- mocha --exit --require ts-node/register --require source-map-support/register src/fake-agent.test.ts src/live-github.test.ts src/run-e2e.test.ts`
- `make check`

Final reviewer result:
- final material-findings-only review reported **no material findings**
- final `review-code` rerun (`.ai/reviews/diff-only/20260428T134128583856Z/review.md`) reported **no must-fix or should-fix findings**

## Live fake-agent E2E evidence

The prescribed Task 5 live fake-agent path succeeded on 2026-04-28 with:
- repo: `Mugenor/orchestrator-testing`
- project: `https://github.com/users/Mugenor/projects/1`
- active GitHub auth: `Mugenor`
- command: `npm --workspace e2e run live:fake`

Observed result:
- run id: `8cfeaa91`
- issue: `https://github.com/Mugenor/orchestrator-testing/issues/30`
- PR: `https://github.com/Mugenor/orchestrator-testing/pull/31`
- statuses: `Ready -> In progress -> In review`
- cleanup attempted: close PR, close issue, delete project item, delete branch
- cleanup failures: none

Additional cleanup performed:
- removed the earlier blocked harness artifact from `runId=5a142140` after the fake harness was updated to seed a deterministic `make check` target (`issue #29`, branch `orchestrator-e2e-5a142140/issue-29`)