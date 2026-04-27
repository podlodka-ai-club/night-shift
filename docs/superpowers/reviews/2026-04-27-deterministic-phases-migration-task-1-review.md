# Task 1 AI Review Artifact

## Scope

Task 1 from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-1.md`:
- normalize the board model to the donor-compatible status vocabulary
- freeze reusable blocked-reason / board-status / signal contract data
- keep current `Ready -> In progress -> In review` behavior green
- update E2E assertions/seed logic to tolerate the richer board lifecycle

## Review pass 1

Reviewer findings:
1. Status normalization rewrote existing status-option metadata instead of preserving `color` / `description`.
2. `e2e/src/live-github.ts` duplicated status-normalization logic instead of reusing the shared GitHub seam.

Resolution:
- preserved existing status-option metadata in `orchestrator/src/activity-github-project.ts`
- routed E2E seeding through `createGitHubActivities(...).ensureProjectStatusOptions(...)`
- added regression coverage for both cases

## Review pass 2

Verdict: **reviewer-happy / no material findings remain**.

Reviewer confirmation:
- AC1 satisfied: dedicated idempotent project-status normalization seam exists
- AC2 satisfied: shared reusable blocked-reason / board-status / signal contract exists
- AC3 satisfied: current ready-flow behavior remains intact
- AC4 satisfied: fake-agent E2E assertions tolerate richer canonical board statuses

## review-code skill pass 1

`review-code` found one follow-up should-fix:
- tighten the `Blocked` contract because Task 1 normalization already guarantees it

Resolution:
- made `SelectedProjectIssue.blockedOptionId` required
- changed project selection to require the `Blocked` option
- removed the obsolete fallback-to-`Ready` failure-path behavior and updated tests

## review-code skill pass 2

Verdict: **clean**.

Verification result from the second `review-code` pass:
- previous `Blocked`-contract finding verified fixed
- no remaining must-fix findings
- no remaining should-fix findings

## Validation evidence

Successful local verification:
- `npm --workspace orchestrator exec -- mocha --exit --require ts-node/register --require source-map-support/register src/mocha/activity-github.test.ts src/mocha/shared.test.ts`
- `npm --workspace e2e test -- --grep "run contract helpers|seedIssueInProject"`
- `npm --workspace orchestrator exec -- mocha --timeout 60000 --exit --require ts-node/register --require source-map-support/register src/mocha/activity-github.test.ts src/mocha/activity-worktree.test.ts src/mocha/activity-agent-sequence-checkpoint.test.ts src/mocha/workflow-success.test.ts src/mocha/workflow-failure.test.ts`
- `make check`

Included review-code artifacts:
- `.ai/reviews/docs-superpowers-plans-2026-04-27-deterministic-phases-migration-task-1/20260427T221936203486Z/review.md`
- `.ai/reviews/docs-superpowers-plans-2026-04-27-deterministic-phases-migration-task-1/20260427T222955868110Z/review.md`
- `.ai/tech-debt.md`

## External blocker

A live fake-agent E2E attempt was made with the pinned repo/project, but GitHub returned `404 Not Found` while creating the seed issue on `Mugenor/orchestrator-testing` under the current local GitHub auth context. This is an environment/access blocker, not a failing local code check.
