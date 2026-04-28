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

- Status: not started
- Notes:

### Task 4

- Status: not started
- Notes:

### Task 5

- Status: not started
- Notes:

### Task 6

- Status: not started
- Notes:

### Task 7

- Status: not started
- Notes:

### Task 8

- Status: not started
- Notes:

### Task 9

- Status: not started
- Notes:
