## Review Scope

Reviewed branch `feat/temporal-simplest-workflow` focused on the Task 6 review-phase implementation for the ready-to-merge happy path. Files inspected: `orchestrator/src/phases/review/*` (errors.ts, phase.ts, prompt.ts, response.ts), `orchestrator/src/activity-github*.ts` (activity-github.ts, activity-github-pull-request.ts, activity-github-client.ts, activity-github-project.ts), `orchestrator/src/workflows.ts`, `orchestrator/src/activities.ts`, all `orchestrator/src/mocha/*.test.ts` files, and `e2e/src/*.ts` files. `make check` was run and confirmed green (all orchestrator unit tests, all E2E unit tests, lint, tsc build pass). No authoritative artifact was supplied; validation was performed against `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-6.md` acceptance criteria directly.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-6.md` — Task 6: Port the Review phase for the ready-to-merge happy path. No external ticket/spec artifact was supplied.

## Acceptance / Spec Coverage

All five acceptance criteria and the definition of done are satisfied:

| AC | Status | Evidence |
|----|--------|----------|
| AC1 — In review item with no error findings → `ready-to-merge` verdict → Ready to merge | ✅ | `decideReviewVerdict` returns `ready-to-merge` when no error findings exist; `buildStatusUpdateInput` maps to `readyToMergeOptionId`; workflow-success tests verify full `In progress → In review → Ready to merge` board progression |
| AC2 — Creates/updates review summary artifacts without duplicating markers across retries | ✅ | `upsertIssueComment` with marker `review:summary` uses the existing marker-based upsert pattern; `upsertPullRequestReviewComment` deduplicates via `night-shift:review:finding` marker matching; activity-github tests verify upsert-vs-create behavior |
| AC3 — Warning-only findings do not block the happy path | ✅ | `decideReviewVerdict` only checks `finding.severity === 'error'`; review-phase test explicitly asserts warning-only → `ready-to-merge`; workflow-success test uses a warning finding and still reaches Ready to merge |
| AC4 — Contract failures classified separately from infrastructure failures | ✅ | `generateReviewResponse` catches `AgentContractError` in the cause chain and wraps it in `ReviewPhaseContractError`; review-phase test verifies this; workflow `nonRetryableErrorTypes: ['AgentContractError']` prevents useless retries |
| AC5 — Tests cover inline review comments and self-review fallback | ✅ | review-phase test verifies `upsertPullRequestReviewComment:src/index.ts:1` call with normalized absolute-to-relative path; APPROVE → COMMENT fallback triggered by "422 cannot approve your own pull request"; activity-github test covers `setPullRequestReady` and `upsertPullRequestReviewComment` with `commit_id` |

Definition of Done verified:
- Unit tests: Review response parsing, verdict calculation, error classification, nullable normalization, schema alignment. ✅
- GitHub-side-effect tests: review summary upserts, inline comment mapping with `commit_id`, `Ready to merge` transitions, `setPullRequestReady` draft→ready. ✅
- Workflow tests: `In review → Ready to merge` success path with full call-sequence assertion including review activities. ✅
- Targeted retry-injection tests: PR-open, comment, and status-update retries all pass through the review phase cleanly. ✅
- `make check` passes from repository root. ✅
- E2E harness: fake-agent test covers deterministic review response; `run-contract.ts` status sequence includes Ready to merge. ✅

## Previous Review Verification

No previous review was supplied. Verification was skipped.

Note: The prior task-6 review (20260428T151352596798Z) logged five tech-debt items. Of those, three have been fixed in follow-up commits (commit_id in inline comments, JSON schema source `.min(1)` alignment, and reviewer schema alignment test). Two remain as legitimate tech debt and are already captured in `.ai/tech-debt.md`.

## Findings

### Must Fix

No must-fix findings.

### Should Fix

- **`ReviewPhaseContractError` still manually assigns `cause`** (`orchestrator/src/phases/review/errors.ts:4-7`): The constructor does `this.cause = cause` instead of `super(message, { cause })`. This was noted as tech debt in the prior review and fixed for `ImplementPhaseContractError` in Task 5. The inconsistency is minor but easy to fix — use `super(message, { cause })` and remove the manual `public readonly cause` field.

## Out-of-Scope Follow-Ups

- `reviewIteration` in `workflows.ts:297` is initialized to 0 and never incremented. The needs-fix retry loop and escalation path are intentionally deferred to Task 7. Already captured in tech-debt.
- `ReviewPhaseContractError` cause assignment inconsistency (already captured in tech-debt).

## Rejected Noise

- The `isUnresolvableInlineCommentError` heuristic in `phase.ts:205-213` uses string matching on error messages. This is pragmatic for handling GitHub API edge cases and matches the donor pattern. Not a finding.
- `describeErrorCauseChain` and `findErrorInCauseChain` are duplicated utility patterns within `phase.ts`. These are local to the review phase and extracting them to shared code would be premature until a third consumer exists.
- The fake-agent review response always returns a warning-only finding, so E2E never exercises the needs-fix/escalate path. This is by design — Task 6 scope is happy path only.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied; validated against task-6.md acceptance criteria directly
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. **Optional quick fix**: Update `ReviewPhaseContractError` to use `super(message, { cause })` for consistency with `ImplementPhaseContractError`. This is a one-line change.
2. **Proceed to Task 7**: The branch is ready to merge for Task 6 scope. Task 7 should wire the needs-fix retry loop, increment `reviewIteration`, and activate the escalation path.
