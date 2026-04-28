# Review: Task 6 — Review Phase Happy Path to Ready to Merge

## Review Scope

Reviewed the full review phase implementation and its integration into the workflow, covering:

- `orchestrator/src/phases/review/*` (phase.ts, prompt.ts, response.ts, errors.ts)
- `orchestrator/src/activity-github-pull-request.ts` (review-related activities)
- `orchestrator/src/activity-github.ts` (activity surface)
- `orchestrator/src/workflows.ts` (review phase wiring)
- `orchestrator/src/mocha/review-phase.test.ts`, `workflow-success.test.ts`, `workflow-shell.test.ts`, `workflow-failure.test.ts`, `phase-response-contracts.test.ts`, `activity-github.test.ts`
- `e2e/src/fake-agent.ts`, `fake-agent.test.ts`, `run-contract.test.ts`, `run-e2e.ts`, `live-github.ts`

No authoritative artifact was supplied; review was performed against the task-6 plan at `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-6.md`.

## Source Artifact

The task-6 plan (`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-6.md`) was used as the reference spec. No external story/ticket was supplied.

## Acceptance / Spec Coverage

All five acceptance criteria appear satisfied:

- **AC1** ✅ Warning-only findings → `ready-to-merge` verdict → `Ready to merge` status transition. Tested at unit, workflow, and E2E levels.
- **AC2** ✅ Marker-based `upsertIssueComment` and `upsertPullRequestReviewComment` prevent duplication across retries. Tested in activity and workflow tests.
- **AC3** ✅ `decideReviewVerdict` returns `ready-to-merge` when no error-severity findings exist. Tested directly.
- **AC4** ✅ `ReviewPhaseContractError` wraps `AgentContractError` separately from infrastructure errors. Tested in `review-phase.test.ts`.
- **AC5** ✅ Inline comment creation tested with resolvable locations. APPROVE → COMMENT fallback tested when GitHub rejects self-review approval.

DoD items are substantially met. One gap: the DoD asks for "targeted runtime integration tests for invalid structured output → repair → success at the phase wrapper" — this is tested as error wrapping but not as a repair-then-succeed path at the phase boundary.

## Previous Review Verification

Previous review verification was skipped (no previous review was supplied).

## Findings

### Must Fix

No must-fix items. The happy-path-to-Ready-to-merge flow is correctly wired and tested.

### Should Fix

- **Missing `commit_id` in `createPullRequestReviewComment`** (`activity-github-pull-request.ts:236-239`): The GitHub REST API documents `commit_id` as required for `POST /pulls/{pull_number}/comments`. The current implementation omits it. Every new inline comment creation will either fail with a 422 (silently swallowed by `isUnresolvableInlineCommentError` which specifically matches `commit_id`) or rely on undocumented implicit behavior. The `headSha` is fetched in `PullRequestDetails` but never threaded to the comment creation call. Since the task spec treats inline comments as "best-effort," this doesn't block the happy path, but it means the inline comment feature is effectively dead code for new comments. Fix: add `commitId` to `UpsertPullRequestReviewCommentInput`, pass `pullRequestDetails.headSha` through, and include it as `commit_id` in the POST body.

- **Schema drift in `reviewerResponseJsonSchemaSource`** (`response.ts:40`): The `location.file` field uses `zodV3.string()` (no min length) while `findingSchema` and `reviewerFindingInputSchema` enforce `z.string().min(1)`. If the LLM returns `{ "file": "", "line": 5 }`, it passes JSON schema validation at the provider but `parseReviewerResponse` throws a Zod error, producing a contract failure instead of graceful handling. Fix: add `.min(1)` to align the JSON schema source with the parser.

- **`ReviewPhaseContractError` uses manual `cause` assignment** (`errors.ts:1-9`): The constructor manually declares `public readonly cause` instead of passing `{ cause }` to `super()`. This shadows the ES2022 `Error.cause` mechanism. While functionally correct due to property shadowing, it doesn't follow the standard pattern established by the task-5 tech-debt fix for `ImplementPhaseContractError`. Fix: use `super(message, { cause })`.

- **No logging on APPROVE → COMMENT fallback** (`phase.ts:127-135`): When the review event is downgraded from APPROVE to COMMENT (e.g., self-review rejection), this happens silently. If branch protection requires approvals, the PR cannot be merged despite the workflow reporting `ready-to-merge`. At minimum, log a warning. Consider propagating the fallback info into the result.

- **`summarizePatch` overcounts by matching diff headers** (`prompt.ts:77-79`): The regexes `^\+` and `^-` with multiline flag also match `+++` and `---` diff headers, inflating addition/deletion counts by 1 each. Low impact since this is only prompt context, but easy to fix with `^\+[^+]` / `^-[^-]`.

## Out-of-Scope Follow-Ups

- `reviewIteration` is never incremented in the workflow shell (`workflows.ts:297`). The escalation path via `decideReviewVerdict` is dead code until Task 7 wires the needs-fix retry loop. Whoever wires the loop must also increment `reviewIteration`.
- Missing `reviewerResponseJsonSchemaSource` alignment test in `phase-response-contracts.test.ts` (the specify and implement schemas have alignment tests; reviewer does not).
- Missing test for `isUnresolvableInlineCommentError` fallback behavior in `review-phase.test.ts` — the graceful skip is not directly tested.
- Missing DoD test: "invalid structured output → repair → success at the phase wrapper" is tested as error wrapping only, not as a repair-then-succeed flow.

## Rejected Noise

- **`isUnresolvableInlineCommentError` matching breadth**: The function matches on the full cause chain and uses broad substrings. While this could theoretically swallow non-positioning 422 errors, the impact is limited to inline comments (best-effort per spec), and the alternative (failing the review phase on unresolvable positions) is worse. The current behavior is acceptable for the happy path scope.
- **`normalizeFindingLocations` returns unresolvable paths unchanged**: This results in 422s that get caught by the inline comment error guard. The chain is intentional — unresolvable paths simply don't get inline comments. The summary comment still includes them.
- **Workflow sets `currentPhase = 'review'` before null-checking `pullRequest`** (`workflows.ts:238-242`): Brief state inconsistency before the throw. Minor observability concern but not a correctness issue.
- **`generateReviewResponse` produces unhelpful Zod error if `result.outputs` is undefined** (`phase.ts:88-89`): The missing output case would produce a generic Zod error rather than a `ReviewPhaseContractError`. Acceptable for now since this would only occur if the agent framework is broken.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact supplied; used task-6 plan as reference
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Thread `commitId` through to `createPullRequestReviewComment` to make inline comments functional.
2. Add `.min(1)` to `reviewerResponseJsonSchemaSource` `location.file` field.
3. Update `ReviewPhaseContractError` to use `super(message, { cause })`.
4. Add a warning log to the APPROVE → COMMENT fallback path.
5. Add the `reviewerResponseJsonSchemaSource` alignment test to `phase-response-contracts.test.ts`.
6. Proceed with Task 7 (needs-fix/escalate wiring), ensuring `reviewIteration` is incremented in the retry loop.
