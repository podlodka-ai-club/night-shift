# Task 6 AI Review Artifact

## Scope

Task 6 from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-6.md`:
- port the real Review happy path on top of the phased shell
- move `In review` items with warning-only / empty findings to `Ready to merge`
- emit/update review summary artifacts and best-effort inline findings
- preserve retry-safe PR/comment/status side effects and live fake-agent proof

## Review pass 1 (`review-code`)

Initial review found five follow-ups:
- inline review comment creation omitted `commit_id`, so the live GitHub API could reject otherwise-resolvable comment placement
- the reviewer JSON-schema source still drifted from the Zod parse schema in `location.file` / optional-field handling
- Task 6 lacked a direct reviewer-schema alignment regression test
- `summarizePatch(...)` counted diff headers as real additions/deletions
- `ReviewPhaseContractError` still used the existing manual `cause` assignment pattern

## Review pass 2

Follow-up fixes landed:
- `upsertPullRequestReviewComment` now threads `commit_id` through the PR-review-comment create path
- `reviewerResponseJsonSchemaSource` now matches the parse schema for `location.file`, optional `line`, optional `location`, and optional `specRef`
- `phase-response-contracts.test.ts` now pins reviewer parser/json-schema alignment directly
- `summarizePatch(...)` now ignores `+++` / `---` diff headers when computing the changed-file summary
- the live GitHub harness now treats duplicate project-item seeding as idempotent and reuses the existing project item id

## Review pass 3 (`review-code`)

The final `review-code` rerun reported:
- no must-fix findings
- one minor should-fix: `ReviewPhaseContractError` still manually assigns `cause`

That remaining item is already captured in `.ai/tech-debt.md`. It is not material for Task 6 acceptance and does not block proceeding to Task 7.

Final verdict: **reviewer-happy / no material findings remain**.

Reviewer confirmation:
- AC1 satisfied: `ready-to-merge` now moves the project item to `Ready to merge` and returns that final status from the workflow shell
- AC2 satisfied: `review:summary` and `review:finding` artifacts use marker-based upsert behavior to avoid duplicate marker comments across retries
- AC3 satisfied: warning-only findings remain non-blocking and still reach `Ready to merge`
- AC4 satisfied: `ReviewPhaseContractError` cleanly separates structured contract failures from infrastructure/runtime failures
- AC5 satisfied: direct tests cover inline-comment mapping plus APPROVE→COMMENT fallback for self-review/API restrictions

## Validation evidence

Successful local verification:
- `npm --workspace orchestrator exec -- mocha --exit --require ts-node/register --require source-map-support/register src/mocha/activity-github.test.ts src/mocha/review-phase.test.ts src/mocha/phase-response-contracts.test.ts src/mocha/workflow-shell.test.ts src/mocha/workflow-success.test.ts`
- `npm --workspace e2e exec -- mocha --exit --require ts-node/register src/fake-agent.test.ts src/live-github.test.ts src/run-contract.test.ts src/run-e2e.test.ts`
- `make check`

Final reviewer result:
- final `review-code` rerun (`.ai/reviews/diff-only/20260428T154029170257Z/review.md`) reported **no must-fix findings** and only one pre-existing minor should-fix already captured as tech debt

## Live fake-agent E2E evidence

The prescribed Task 6 live fake-agent path succeeded on 2026-04-28 with:
- repo: `Mugenor/orchestrator-testing`
- project: `https://github.com/users/Mugenor/projects/1`
- active GitHub auth: `Mugenor`
- command: `npm --workspace e2e run live:fake`

Observed result:
- run id: `9fd97d77`
- issue: `https://github.com/Mugenor/orchestrator-testing/issues/43`
- PR: `https://github.com/Mugenor/orchestrator-testing/pull/44`
- statuses: `Ready -> In progress -> In review -> Ready to merge`
- cleanup attempted: close PR, close issue, delete project item, delete branch
- cleanup failures: none