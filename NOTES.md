# Deterministic Phases Migration — Execution Directives

## Source of truth

- Execute tasks strictly in order: `task-1.md` through `task-9.md`
- Before each task:
  - read the task file
  - read any relevant notes in this file
  - read any code or docs needed to implement the task safely
- Use the pinned strategy docs as the migration authority:
  - `docs/superpowers/specs/2026-04-27-deterministic-phases-migration-map.md`
  - `docs/superpowers/specs/2026-04-27-deterministic-phases-workflow-reference.md`

## Required workflow for every task

For each task from Task 1 to Task 9:

1. Read the task file and any related notes.
2. Implement the task.
3. Run `make check` and fix issues until it passes.
4. Run AI code review and review-code skill and iterate until the reviewer is happy.
5. Record important follow-up notes in this file.
6. Commit the task changes together with the AI review artifacts/findings.

## Notes-writing rules

- Every note must say:
  - which task originated the note
  - which later task(s) the note is relevant to
- Keep notes short, concrete, and implementation-oriented.
- Prefer adding notes only when they materially affect later tasks.

## Commit expectations

- Commit after each task is complete.
- Include the task implementation changes and associated AI review artifacts/findings in the same commit.
- Do not skip verification or review before committing.

## Running log

### Task 1

- Status: complete
- Notes:
  - [Origin: Task 1 | Relevant to: Tasks 2-9] Canonical donor-compatible board data now lives in `orchestrator/src/shared.ts` (`CANONICAL_PROJECT_STATUS_NAMES`, `READY_ISSUE_STATUS_SEQUENCE`, `BLOCKED_REASON_BOARD_SIGNAL_RULES`). Reuse these exports instead of re-copying status/signal rules into later workflow, trigger, pickup, or E2E code.
  - [Origin: Task 1 | Relevant to: Tasks 2, 5, 8] The GitHub project normalization seam is implemented in `orchestrator/src/activity-github-project.ts` and exposed via `createGitHubActivities(...).ensureProjectStatusOptions(...)`. Later GitHub-backed flows should go through this seam so status-option creation stays idempotent and metadata-preserving.
  - [Origin: Task 1 | Relevant to: Tasks 2-9] After the `review-code` pass, `SelectedProjectIssue.blockedOptionId` is now required rather than optional. Later phase/failure-path code should treat `Blocked` as guaranteed by board normalization and should not reintroduce fallback-to-`Ready` semantics.
  - [Origin: Task 1 | Relevant to: Tasks 2-9] `e2e/src/live-github.ts` now seeds issues through the shared GitHub status-normalization activity instead of a local copy. Keep that reuse pattern when later phase/status behavior expands.
  - [Origin: Task 1 | Relevant to: Tasks 2-9] Local validation is green via `make check`, but the live fake-agent E2E run is currently blocked externally: creating an issue in `Mugenor/orchestrator-testing` returned `404 Not Found` under the current GitHub CLI auth context. Before relying on live GitHub validation in later tasks, use a token/account with access to the pinned repo/project or update the pinned target if it has changed.

### Task 2

- Status: complete
- Notes:
  - [Origin: Task 2 | Relevant to: Tasks 3-9] The provider/runtime seam now centers on `AgentSession` plus `createCodexAgentAdapter(...)` in `orchestrator/src/activity-deps.ts`, and structured-output repair/checkpoint logic lives in `orchestrator/src/activity-agent-turn.ts`. Later phase work should build on these seams instead of extending `runAgentSequence` inline.
  - [Origin: Task 2 | Relevant to: Tasks 3-7] Phase-local response contracts now exist in `orchestrator/src/phases/{specify,implement,review}/response.ts`, with donor-compatible path/shape validation and zod-v3 json-schema sources kept aligned with the runtime validators by tests.
  - [Origin: Task 2 | Relevant to: Tasks 3-7] Pending structured-step completions are now re-validated against their schema during heartbeat resume before they are finalized. Later structured outputs should preserve JSON-safe shapes or add explicit normalization on resume if they introduce richer runtime types.
  - [Origin: Task 2 | Relevant to: Tasks 3-9] The current Ready-path `change-metadata` caller now runs through the adapter-backed `runStructuredAgentTurn(...)` helper without changing outward workflow behavior. Reuse that helper pattern when Specify/Implement/Review become real workflow phases.
  - [Origin: Task 2 | Relevant to: Tasks 3-9] Local verification is green via `make check`, `npm --workspace e2e exec -- tsc --noEmit`, and three clean `review-code` iterations.
  - [Origin: Task 2 | Relevant to: Tasks 3-9] The prescribed real-agent smoke succeeded on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` under the `Mugenor` GitHub auth context (`runId=3a8be06c`, observed statuses `Ready -> In progress -> In review`, PR/comment/status artifacts verified, cleanup succeeded with no failures). Use this same auth context/target when later tasks require live GitHub validation.

### Task 3

- Status: complete
- Notes:
  - [Origin: Task 3 | Relevant to: Tasks 4-6, 8-9] `orchestrator/src/workflows.ts` is now a phased shell that tracks `startPhase`, `currentPhase`, `blockedReason`, review-iteration metadata, and markdown `setCurrentDetails()` output. Later phase ports should mutate this shared shell state rather than bypassing it with phase-local ad hoc flags.
  - [Origin: Task 3 | Relevant to: Tasks 4-6, 8-9] Workflow-facing phase-control contracts now live in code as exported Temporal definitions (`specifyRetrySignal`, `specReviewedSignal`, `implementRetrySignal`, `resumeSignal`, `activityProgressSignal`, `getBlockedReasonQuery`). Reuse these exports from future trigger/test code instead of re-copying signal/query names.
  - [Origin: Task 3 | Relevant to: Tasks 4-6] `orchestrator/src/mocha/workflow-test-helpers.ts` now supports `workflowInput` overrides and `runWorkflowWithHandle(...)`, which made signal/query testing possible. Use this helper for future Specify/Implement/Review shell tests instead of building parallel Temporal harness code.
  - [Origin: Task 3 | Relevant to: Tasks 4-6] The `specify` and `review` phases are still shell placeholders: `specify` currently blocks on approval and `review` is a terminal no-op after successful implement execution. Task 4 and Task 6 should replace those placeholders while preserving the now-tested `implement` entry path.
  - [Origin: Task 3 | Relevant to: Tasks 4-9] Task 3 verification is green via `make check`, a clean second `review-code` pass, and a live fake-agent E2E run on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` (`runId=5f75c302`, statuses `Ready -> In progress -> In review`, cleanup succeeded with no failures). Reuse the same auth context/targets for later live GitHub-backed validation unless the pinned target changes.

### Task 4

- Status: complete
- Notes:
  - [Origin: Task 4 | Relevant to: Tasks 5-8] The real Specify slice now lives in `orchestrator/src/phases/specify/` with a dedicated prompt builder, phase runner, response parser, and contract error. Later phase work should extend those boundaries instead of re-embedding spec-generation logic in `workflows.ts`.
  - [Origin: Task 4 | Relevant to: Tasks 5-8] The workflow now caches the selected Backlog issue across `specifyRetry` loops (`selectedSpecifyIssue`) so operator retries keep editing the same GitHub issue / project item. Future signal-driven retries should preserve that invariant unless a task explicitly re-queues selection.
  - [Origin: Task 4 | Relevant to: Tasks 5-6, 8] `openPullRequest` now supports `draft` and `updateIfExists`; the implement phase uses `updateIfExists: true` so a draft spec PR can be refreshed into the implementation PR instead of leaving stale spec metadata behind.
  - [Origin: Task 4 | Relevant to: Tasks 5-8] Shared Night Shift comment-marker helpers live in `orchestrator/src/comment-markers.ts`. Reuse that module for prompt filtering and marker-comment upserts instead of duplicating the HTML marker format.
  - [Origin: Task 4 | Relevant to: Tasks 5-8] New activities now cover `getTopBacklogIssue`, issue-comment listing/upsert, OpenSpec draft file read/write, and `openspec validate <change> --strict`. The fake-agent E2E harness exercises the full Backlog → Specify gate and manually performs the operator review handoff (`Refined` → `Ready` + `specReviewedSignal`) because automatic board-transition approval is still deferred to Task 8.
  - [Origin: Task 4 | Relevant to: Tasks 5-8] Task 4 verification is green via `make check`, a clean second `review-code` pass, and a live fake-agent E2E run on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` (`runId=8d4ac1ef`, issue `#27`, PR `#28`, statuses `Backlog -> Refinement -> Refined -> Ready -> In progress -> In review`, cleanup succeeded). Two preserved harness-failure runs (`#23/#24`, `#25/#26`) were manually cleaned afterward.

### Task 5

- Status: complete
- Notes:
  - [Origin: Task 5 | Relevant to: Tasks 6-8] The real Implement slice now lives under `orchestrator/src/phases/implement/` with dedicated prompt, response parser, contract/runtime error boundaries, and a shared `phases/change-name.ts` helper for deterministic `openspec/changes/<changeName>` folder names. Extend those boundaries for later Review/Merge work instead of re-embedding Ready-path logic in `workflows.ts`.
  - [Origin: Task 5 | Relevant to: Tasks 6-8] Implement now owns `writeRepositoryFiles`, `runQualityGate`, the typed retry-feedback loop, and `implement:summary` side effects. Later phases should keep using the current worktree/PR activities while leaving quality-gate/prompt semantics phase-local.
  - [Origin: Task 5 | Relevant to: Tasks 6-8] Repair-exhausted structured-output failures are now wrapped in `activity-agent-sequence.ts` as non-retryable `AgentContractError` application failures, and the Implement phase only treats `/invalid/` as contract feedback when parsing the returned Implement payload locally. Reuse that split for later Review structured contracts instead of broad message matching.
  - [Origin: Task 5 | Relevant to: Tasks 6-8] Workflow tests now pin retry-safe windows after push/PR/comment/status updates (`workflow-success.test.ts`) and `implementRetry` continues to reuse the same selected Ready issue/worktree until the operator unblocks the phase. Preserve that reuse model unless a later task explicitly changes branch/worktree policy.
  - [Origin: Task 5 | Relevant to: Tasks 6-8] The fake-agent live E2E harness now starts fake runs directly in Implement by pre-seeding the approved spec bundle plus a deterministic `Makefile` `check` target, while `live:real` still starts in Specify via `resolveStartPhase(...)`. Keep that split so fake Ready-start validation remains cheap without breaking real-agent paths.
  - [Origin: Task 5 | Relevant to: Tasks 6-8] Task 5 verification is green via focused orchestrator/E2E suites, final `make check`, and a live fake-agent E2E run on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` (`runId=8cfeaa91`, issue `#30`, PR `#31`, statuses `Ready -> In progress -> In review`, cleanup succeeded). An earlier blocked run (`#29`, `runId=5a142140`) exposed the missing `make check` target in the test repo and was cleaned after the harness fix landed.

### Task 6

- Status: complete
- Notes:
  - [Origin: Task 6 | Relevant to: Tasks 7-8] The real Review slice now lives under `orchestrator/src/phases/review/` with a dedicated prompt builder, response parser, verdict helper, summary rendering, and `ReviewPhaseContractError`. Extend those boundaries for needs-fix/escalation work instead of re-embedding review semantics in `workflows.ts`.
  - [Origin: Task 6 | Relevant to: Tasks 7-8] Review now owns PR-head context gathering (`getPullRequestDetails`, diff/files/comment fetches), APPROVE→COMMENT fallback for self-review/API restrictions, `review:summary` issue-comment upserts, and best-effort inline review comments keyed by `review:finding`. Task 7 should reuse those helpers while wiring the retry/escalation loop.
  - [Origin: Task 6 | Relevant to: Tasks 7-8] `SelectedProjectIssue` now carries `readyToMergeOptionId`/`readyToMergeStatusName`, and the shell happy path is pinned as `Ready -> In progress -> In review -> Ready to merge`. Preserve that canonical end-state in later workflow/E2E assertions unless a later task intentionally broadens the board lifecycle.
  - [Origin: Task 6 | Relevant to: Tasks 7-8] The fake-agent harness now emits a deterministic Review response and the live GitHub harness validates `review:summary` artifacts plus `Ready to merge`. The seeding helper also tolerates GitHub/project automation already adding the issue to the project by resolving the existing project item id instead of failing the run.
  - [Origin: Task 6 | Relevant to: Tasks 7-8] Task 6 verification is green via focused orchestrator/E2E suites, final `make check`, a live fake-agent E2E run on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` (`runId=9fd97d77`, issue `#43`, PR `#44`, statuses `Ready -> In progress -> In review -> Ready to merge`, cleanup succeeded), and a final `review-code` rerun with no material findings. One minor should-fix (`ReviewPhaseContractError` cause assignment consistency) remains captured in `.ai/tech-debt.md`.

### Task 7

- Status: complete
- Notes:
  - [Origin: Task 7 | Relevant to: Tasks 8-9] The workflow shell now owns bounded review looping directly: `needs-fix` increments `reviewIteration` and immediately reruns `Implement`, while final-iteration `escalate` blocks on `review_escalation` until `resumeSignal` resets the loop back to `Implement` iteration 1. Future intake automation should reuse these existing signals instead of adding phase-local bypasses.
  - [Origin: Task 7 | Relevant to: Tasks 8-9] Review escalation now adds the `night-shift:escalation` issue label, upserts `review:escalation`, and preserves retry-safe marker semantics for both review summaries and workflow failures. Later board/pickup automation should surface these markers/labels rather than introducing parallel operator-notification paths.
  - [Origin: Task 7 | Relevant to: Tasks 8-9] All thrown Specify/Implement/Review failures now funnel through a shared `workflow:phase-failure` blocked-comment path that names the failed phase, root cause, and suggested board reset status (`Backlog` for Specify, `Ready` for Implement/Review). Keep later recovery/intake work aligned with that UX instead of silently failing or inventing new comment formats.
  - [Origin: Task 7 | Relevant to: Task 8] The fake-agent harness now deterministically exercises one review rerun before `Ready to merge`, and the run-contract accepts either the original happy path or the rerun sequence (`Ready -> In progress -> In review -> Ready -> In progress -> In review -> Ready to merge`). Task 8 intake automation should preserve that no-webhook scope and continue using pickup/manual triggers only.
  - [Origin: Task 7 | Relevant to: Tasks 8-9] Task 7 verification is green via focused orchestrator/E2E suites, final `make check`, a live fake-agent E2E run on 2026-04-28 against `Mugenor/orchestrator-testing` + Project `Mugenor/1` (`runId=49d4743e`, issue `#48`, PR `#49`, statuses `Ready -> In progress -> In review -> Ready -> In progress -> In review -> Ready to merge`, cleanup succeeded), and a final `review-code` rerun with no material findings. Remaining should-fix cleanup (phase error `cause` consistency + duplicated cause-chain helpers) is captured in `.ai/tech-debt.md`.

### Task 8

- Status: not started
- Notes:

### Task 9

- Status: not started
- Notes:
