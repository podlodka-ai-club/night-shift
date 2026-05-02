# Task 4 AI Review Artifact

## Scope

Task 4 from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-4.md`:
- port the first real Specify phase
- write and validate OpenSpec draft files under `openspec/changes/<changeName>`
- create/update a draft spec PR and marker comment
- block on `awaiting_spec_review` / `specify_needs_input`
- prove the fake-agent harness can drive a Backlog-started issue through the Specify gate

## Review pass 1

`review-code` found one must-fix and three should-fix items:
- **must-fix:** keep the same selected Backlog issue across `specifyRetry` instead of re-querying and potentially switching tickets mid-review loop
- dedupe Night Shift marker helpers into a shared module
- improve the second-attempt OpenSpec validation error message
- questioned whether the `AgentContractError` non-retryable wiring was still effective

## Review pass 2

Follow-up fixes landed:
- cached the selected Backlog issue across Specify retries in `workflows.ts`
- moved Night Shift marker helpers into `orchestrator/src/comment-markers.ts`
- changed repaired-validation failures to throw `OpenSpec validation still failed after one repair attempt: ...`
- left the `AgentContractError` activity retry configuration intact because it still applies at the activity boundary before the workflow-level phase wrapper rethrows

Verdict: **reviewer-happy / no material findings remain**.

Reviewer confirmation:
- AC1 satisfied: Backlog issues enter Refinement, write OpenSpec change files, and validate through the new Specify phase runner
- AC2 satisfied: refined specs create/update a draft PR, upsert `specify:summary`, move to Refined, and block on `awaiting_spec_review`
- AC3 satisfied: open questions / validator retry failures block on `specify_needs_input`, upsert operator-visible context, and move to Blocked
- AC4 satisfied: workflow tests cover `specReviewed` and `specifyRetry`, including stale-signal rejection
- AC5 satisfied: prompt, response-contract, validator-retry, repair, and non-retryable contract-failure paths are covered by unit/runtime tests

## Validation evidence

Successful local verification:
- `npm --workspace orchestrator exec -- mocha --exit --require ts-node/register --require source-map-support/register src/mocha/activity-agent-sequence-runtime.test.ts src/mocha/specify-phase.test.ts src/mocha/workflow-shell.test.ts`
- `npm --workspace e2e exec -- mocha --exit --require ts-node/register --require source-map-support/register src/fake-agent.test.ts src/live-github.test.ts src/run-contract.test.ts src/run-e2e.test.ts`
- `make check`

Included review-code artifacts:
- `.ai/reviews/diff-only/20260428T094730759513Z/review.md`
- `.ai/reviews/diff-only/20260428T095653661655Z/review.md`
- `.ai/tech-debt.md`

## Live fake-agent E2E evidence

The prescribed Task 4 live fake-agent path succeeded on 2026-04-28 with:
- repo: `Mugenor/orchestrator-testing`
- project: `https://github.com/users/Mugenor/projects/1`
- active GitHub auth: `Mugenor`
- command: `npm --workspace e2e run live:fake`

Observed result:
- run id: `8d4ac1ef`
- issue: `https://github.com/Mugenor/orchestrator-testing/issues/27`
- PR: `https://github.com/Mugenor/orchestrator-testing/pull/28`
- statuses: `Backlog -> Refinement -> Refined -> Ready -> In progress -> In review`
- cleanup attempted: close PR, close issue, delete project item, delete branch
- cleanup failures: none

Additional cleanup performed:
- removed preserved harness-failure artifacts from prior false-negative runs: issue/PR `#23/#24` and `#25/#26`, including project items and branches