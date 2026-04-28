# Task 4 — Specify Phase & Spec-Review Gate Review

## Review Scope

Reviewed the full branch `feat/temporal-simplest-workflow` against task-4 acceptance criteria from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-4.md`. Files inspected: `orchestrator/src/phases/specify/phase.ts`, `phases/specify/prompt.ts`, `phases/specify/response.ts`, `phases/specify/errors.ts`, `orchestrator/src/comment-markers.ts`, `orchestrator/src/workflows.ts`, `orchestrator/src/shared.ts`, `orchestrator/src/activity-github.ts`, `orchestrator/src/activity-github-pull-request.ts`, `orchestrator/src/activity-worktree.ts`, `orchestrator/src/agent-schema-registry.ts`, `orchestrator/src/activities.ts`, all Mocha test suites (`workflow-shell.test.ts`, `phase-response-contracts.test.ts`, `shared.test.ts`, and test helpers), and the E2E fake-agent harness (`e2e/src/fake-agent.ts`, `e2e/src/fake-agent.test.ts`). `make check` verified green (lint, 77 orchestrator tests, 21 E2E tests, tsc build). No authoritative artifact was supplied.

## Source Artifact

Task-4 plan (`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-4.md`). No external ticket or spec artifact was supplied.

## Acceptance / Spec Coverage

All five acceptance criteria are satisfied:

1. **AC1** (Backlog → Specify → Refinement, writes OpenSpec change files): `runSpecifyPhase` moves the issue to `refinementOptionId` immediately, creates/reuses a worktree, reads existing draft files, generates the spec via the agent, then writes files under `openspec/changes/<changeName>`. The `buildSpecifyChangeName` helper produces the donor-compatible `<issueNumber>-<slug>` pattern.
2. **AC2** (successful spec → draft PR, upsert `specify:summary`, move to Refined, block `awaiting_spec_review`): The refined path in `phase.ts` lines 66–77 commits, opens a draft PR, upserts the marker comment with PR link appended, moves to `refinedOptionId`, returns `outcome: 'refined'`. The workflow then blocks on `awaiting_spec_review` (line 166). Workflow test "runs a refined specify pass…" exercises the full path end-to-end through Temporal.
3. **AC3** (validator failure / open questions → upsert summary, move to Blocked, block `specify_needs_input`): Open-questions path returns `needs_input` (line 63). Validation retry at lines 46–55 retries once; second failure throws with `"OpenSpec validation still failed after one repair attempt"`. Workflow test "blocks on specify_needs_input…" covers the signal roundtrip.
4. **AC4** (signal tests for `specReviewed` and `specifyRetry`): Both workflow tests exercise gating via `specReviewedSignal` and `specifyRetrySignal`, confirming stale signals (e.g., `resumeSignal` while specify-blocked) are correctly rejected.
5. **AC5** (phase-level contract tests for invalid output, repair, non-retryable classification): `phase-response-contracts.test.ts` covers SpecifyResponse schema validation (required files, duplicates, allowed paths, parser↔JSON-schema alignment). `SpecifyPhaseContractError` wraps `AgentContractError` for non-retryable classification. The `runAgentSequence` proxy in the workflow passes `['AgentContractError']` as `nonRetryableErrorTypes`.

Definition of Done verified:
- Unit tests for prompt rendering, schema/parser invariants, validator-retry behavior, and file-path rules. ✅
- Workflow tests for both `awaiting_spec_review` and `specify_needs_input` gates. ✅
- GitHub side-effect tests for draft spec PR creation and marker comment upserts. ✅
- `make check` passes from repository root. ✅
- E2E fake-agent returns a deterministic OpenSpec bundle and the test verifies it. ✅

Scope-specific items from the review iteration request:
- **Selected backlog issue cached across specify retries**: `selectedSpecifyIssue ??= await getTopBacklogIssue(input)` at `workflows.ts:121` ensures a single selection. Workflow test asserts `getTopBacklogIssue` is called exactly once across two specify iterations. ✅
- **Night Shift marker helpers deduplicated**: `comment-markers.ts` is the single shared module exporting `NIGHT_SHIFT_MARKER_PREFIX`, `buildNightShiftMarker`, and `isNightShiftMarkerComment`. Both `activity-github-pull-request.ts` and `phases/specify/prompt.ts` import from it. ✅
- **Validation-retry failure surfaces clearer error**: `phase.ts:54` throws `"OpenSpec validation still failed after one repair attempt: <retryError>"`, providing the second-attempt error message. ✅

## Previous Review Verification

Previous review verification was skipped (no previous review was supplied).

## Findings

### Must Fix

_(none)_

### Should Fix

_(none)_

## Out-of-Scope Follow-Ups

- `openspec` binary availability is assumed but not verified at worker startup — already captured in tech-debt.md (Task 4 section).
- `seedIssueInProject` `initialStatusName` accepts untyped `string` — already captured in tech-debt.md.
- `isRetryableProjectSelectionError` only recognizes "Ready" and "Backlog" — already captured in tech-debt.md.
- `updatePullRequest` falls back to dummy title/body defaults — already captured in tech-debt.md.

All out-of-scope follow-ups from task 4 are already captured. No new items to append.

## Rejected Noise

- The `waitForBlockedReason` polling helper in `workflow-shell.test.ts` uses a busy-wait loop (400 × 25ms). Pragmatic test-only pattern for querying Temporal workflow state.
- `specifyResponseSchema` and `specifyResponseJsonSchemaSource` duplicate the schema shape across Zod v4 and Zod v3. This is a structural requirement for the Zod→JSON-Schema bridge and does not warrant deduplication.
- `fake-agent.ts` uses turn-counting heuristics to distinguish Specify vs. Implement responses. Acceptable for a deterministic E2E harness.

## Review Metadata

- Actual Review Mode: branch-only
- Fallback Reason: no authoritative artifact was supplied; used task-4 plan as reference
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

No blocking or advisory findings remain. The implementation satisfies all task-4 acceptance criteria. Proceed to task 5.
