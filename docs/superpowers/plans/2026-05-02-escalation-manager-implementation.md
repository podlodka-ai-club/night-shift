# Escalation Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Escalation Manager phase that uses `Escalated` as the automation-recovery status, attempts safe repair in the same workflow/worktree/branch, and reserves `Blocked` for human-only fallback.

**Source Design:** `docs/superpowers/specs/2026-05-02-escalation-manager-design.md`

**Architecture:** Keep escalation inside `automateTopReadyIssue` as an inline phase/subroutine owned by the current ticket workflow. Reuse the existing selected issue, deterministic worktree, branch, PR context, phase retry signals, marker comments, and validation activities. Add a dedicated escalation phase module and structured response contract; the agent proposes analysis and file changes, while workflow/activities enforce status changes, comments, commits, PR updates, and validation.

**Tech Stack:** TypeScript, Temporal workflows/activities, GitHub Project v2, OpenSpec, Mocha, fake-agent/live GitHub E2E harness.

---

### Task 1: Add the `Escalated` board contract and regression tests

**Files:**
- Modify: `orchestrator/src/shared.ts`
- Modify: `orchestrator/src/activity-github-project.ts`
- Modify: `orchestrator/src/activity-github.ts`
- Modify: `orchestrator/src/config.ts`
- Modify: `orchestrator/src/entrypoint-config.ts`
- Modify: `orchestrator/src/mocha/activity-github*.test.ts`
- Modify: `orchestrator/src/mocha/config.test.ts`
- Modify: `e2e/src/live-github.ts`
- Modify: `e2e/src/live-github.test.ts`

- [ ] Add `Escalated` to the canonical project status set while preserving `Blocked` as the human fallback status.
- [ ] Add `DEFAULT_ESCALATED_STATUS`, `escalatedOptionId`, and `escalatedStatusName` to shared contracts and selected issue mapping.
- [ ] Add config/env plumbing for overriding the escalated status name if the existing status names can be overridden in the same layer.
- [ ] Update project status normalization tests to prove both `Escalated` and `Blocked` are created idempotently and metadata is preserved.
- [ ] Update E2E status seeding/assertion helpers so future runs can observe `Escalated` without local test-only copies of board metadata.
- [ ] Run the focused GitHub/status/config tests before moving on.

### Task 2: Add the Escalation Manager agent profile and activity seam

**Files:**
- Modify: `orchestrator/src/config.ts`
- Modify: `orchestrator/src/activity-deps.ts`
- Modify: `orchestrator/src/activity-agent-sequence.ts`
- Modify: `orchestrator/src/mocha/config.test.ts`
- Modify: `orchestrator/src/mocha/activity-agent-sequence-runtime.test.ts`
- Modify: `orchestrator/README.md`

- [ ] Add an escalation-specific agent profile contract using model `gpt-5.4` with high reasoning.
- [ ] Keep the existing default agent model/reasoning unchanged for Specify, Implement, Review, and legacy agent paths.
- [ ] Thread the escalation profile through the agent activity path without making model choice controllable by structured-output payloads.
- [ ] Add tests proving escalation turns use the escalation profile and normal phase turns keep the existing profile.
- [ ] Document the escalation profile and cost-control intent in the operator README.
- [ ] Run focused config and agent-sequence tests.

### Task 3: Define the escalation structured response contract

**Files:**
- Add: `orchestrator/src/phases/escalation/response.ts`
- Add: `orchestrator/src/phases/escalation/errors.ts`
- Modify: `orchestrator/src/agent-schema-registry.ts`
- Modify: `orchestrator/src/shared.ts`
- Add: `orchestrator/src/mocha/escalation-response.test.ts`

- [ ] Add `escalation-response-v1` to `AgentSchemaId` and the schema registry.
- [ ] Define a zod-v3-compatible response schema for `resolved` and `needs_human` outcomes.
- [ ] Enforce bounded string sizes for root cause, evidence, validation plan, issue comments, and file content.
- [ ] Reject absolute paths, `.git`, dependency caches, credential-looking paths, duplicate paths, and paths outside the worktree contract.
- [ ] Enforce that `needs_human` requires `humanRequest`, and `resolved` requires high/medium confidence plus either file changes or an explicit no-change rationale.
- [ ] Keep `resumeStatus` workflow-derived rather than model-authoritative; parser output may report intent but phase code must recompute the actual target status.
- [ ] Add parser/schema tests for valid resolution, valid human fallback, invalid paths, invalid confidence, and oversized comments.

### Task 4: Add escalation prompt/context assembly

**Files:**
- Add: `orchestrator/src/phases/escalation/prompt.ts`
- Add: `orchestrator/src/mocha/escalation-prompt.test.ts`
- Modify: `orchestrator/src/comment-markers.ts` if marker filtering needs shared helpers

- [ ] Build the escalation system/user prompt with the guidance from the design spec.
- [ ] Include origin phase, blocked reason, issue context, visible operator comments, recent phase summaries, OpenSpec files, worktree/branch context, and latest validation/failure evidence.
- [ ] Include PR details, changed files, diff summary, and review comments when a PR exists.
- [ ] Filter Night Shift marker comments from operator-context sections while still including concise prior phase summaries as machine context.
- [ ] State explicitly that the agent must not move statuses, approve/merge PRs, create branches, close issues, or bypass the phase workflow.
- [ ] Add prompt tests for Specify, Implement, Review, infrastructure failure, and PR/no-PR contexts.

### Task 5: Implement the escalation phase runner without workflow routing

**Files:**
- Add: `orchestrator/src/phases/escalation/phase.ts`
- Modify: `orchestrator/src/activities.ts`
- Modify: `orchestrator/src/activity-worktree.ts` if reusable git/diff helpers are needed
- Add: `orchestrator/src/mocha/escalation-phase.test.ts`

- [ ] Create `runEscalationPhase(...)` that accepts the origin phase, original blocked reason/failure, selected issue, current worktree when available, optional PR context, and phase validation evidence.
- [ ] Reuse or create the deterministic issue worktree; never create a new branch for escalation.
- [ ] Run the escalation agent with the escalation schema/profile and parse the response.
- [ ] Apply returned file changes through controlled write activities, not arbitrary model-side git commands.
- [ ] Run phase-appropriate validation: OpenSpec validation for Specify recovery, quality gate for Implement/Review recovery, and refreshed PR/review context for Review recovery.
- [ ] Allow at most one repair turn when validation fails with actionable feedback.
- [ ] Commit and push to the same automation branch only after validation succeeds and files changed.
- [ ] Upsert `escalation:summary` on resolved outcomes and `escalation:human-needed` on human fallback before moving statuses.
- [ ] Add phase tests for resolved with file changes, resolved with no changes, validation repair success, validation repair exhaustion, unsafe low-confidence fallback, and unexpected agent failure fallback.

### Task 6: Route normal blocked outcomes through escalation

**Files:**
- Modify: `orchestrator/src/workflows.ts`
- Modify: `orchestrator/src/phases/specify/phase.ts`
- Modify: `orchestrator/src/phases/implement/phase.ts`
- Modify: `orchestrator/src/phases/review/phase.ts`
- Modify: `orchestrator/src/mocha/workflow-shell.test.ts`
- Modify: `orchestrator/src/mocha/workflow-success.test.ts`

- [ ] Change Specify `needs_input`, Implement `needs_input`, and Review `escalated` paths to move to `Escalated` and call the escalation subroutine before waiting for human signals.
- [ ] Preserve the existing phase summary/comment-before-status ordering before entering `Escalated`.
- [ ] On successful Specify recovery, move to `Backlog`, clear escalation state, and rerun Specify.
- [ ] On successful Implement recovery, move to `Ready`, clear escalation state, and rerun Implement.
- [ ] On Review recovery with code/spec changes, move to `Ready` and rerun Implement then Review.
- [ ] Preserve existing human fallback signals after escalation gives up and moves the item to `Blocked`.
- [ ] Track escalation attempt count/current origin in workflow state and `renderWorkflowCurrentDetails(...)`.
- [ ] Add workflow tests for all three phase outcomes: escalation resolved, escalation human fallback, and stale/manual signals.

### Task 7: Route eligible infrastructure/runtime phase failures through escalation

**Files:**
- Modify: `orchestrator/src/workflows.ts`
- Modify: `orchestrator/src/mocha/workflow-shell.test.ts`
- Modify: `orchestrator/src/mocha/workflow-test-helpers.ts` if helper support is needed

- [ ] Replace direct workflow-level phase-failure-to-`Blocked` handling with escalation when the workflow has enough selected issue context to attempt recovery.
- [ ] Preserve original error reporting if escalation handling itself fails.
- [ ] Move to `Blocked` with `workflow:phase-failure` plus `escalation:human-needed` when infrastructure recovery is ineligible or unsafe.
- [ ] Preserve the worktree for all infrastructure failure fallbacks.
- [ ] Add tests for Specify, Implement, and Review thrown failures entering escalation.
- [ ] Add tests for failures that happen before issue/worktree context is available and therefore must use direct human fallback.

### Task 8: Add long-term Review-only recovery from `In review`

**Files:**
- Modify: `orchestrator/src/shared.ts`
- Modify: `orchestrator/src/intake.ts`
- Modify: `orchestrator/src/workflows.ts`
- Modify: `orchestrator/src/mocha/intake.test.ts`
- Modify: `orchestrator/src/mocha/workflow-shell.test.ts`
- Modify: `orchestrator/WORKFLOW.md`

- [ ] Add an explicit review-only recovery path that resumes from `In review` without rerunning Implement when escalation resolves stale review context or invalid review findings without code/spec changes.
- [ ] Keep the existing `review_escalation` `Ready` path that reruns Implement then Review for code/spec/worktree changes.
- [ ] Update the board-status/signal mapping so `In review` remains a valid review recovery signal without starting detached workflows.
- [ ] Add intake tests proving `Escalated` does not start missing/closed workflows and `In review` only signals already-open eligible workflows.
- [ ] Update workflow docs to show both Review recovery branches.

### Task 9: Update pickup/manual intake and fake-agent harness

**Files:**
- Modify: `orchestrator/src/pickup.ts`
- Modify: `orchestrator/src/pickup-activities.ts`
- Modify: `orchestrator/src/client.ts`
- Modify: `orchestrator/src/mocha/pickup*.test.ts`
- Modify: `orchestrator/src/mocha/client*.test.ts`
- Modify: `e2e/src/fake-agent.ts`
- Modify: `e2e/src/fake-agent.test.ts`
- Modify: `e2e/src/run-contract.ts`
- Modify: `e2e/src/run-contract.test.ts`

- [ ] Keep scheduled pickup focused on normal starts/signals, with `Escalated` treated as open-workflow recovery only.
- [ ] Ensure manual intake can inspect or signal `Escalated` only when an open workflow owns the issue.
- [ ] Add fake-agent escalation responses for resolved, needs-human, and review-only recovery paths.
- [ ] Extend run-contract status sequences to allow `Escalated -> Backlog`, `Escalated -> Ready`, `Escalated -> In review`, and `Escalated -> Blocked` where appropriate.
- [ ] Add focused pickup/client/fake-agent tests before live harness work.

### Task 10: Documentation, live verification, and final hardening

**Files:**
- Modify: `orchestrator/README.md`
- Modify: `orchestrator/WORKFLOW.md`
- Modify: `e2e/README.md`
- Modify: `docs/superpowers/specs/2026-05-02-escalation-manager-design.md` if implementation discovers needed clarifications
- Add: `docs/superpowers/reviews/2026-05-02-escalation-manager-review.md` after review passes

- [ ] Update operator docs so `Escalated` means automated recovery and `Blocked` means human handoff.
- [ ] Document the escalation profile: `gpt-5.4`, high reasoning, bounded attempts, and expected cost profile.
- [ ] Document issue comment markers and the summary-plus-PR-link rule.
- [ ] Run focused suites first, then `make check`.
- [ ] Run the fake-agent live E2E path for automated recovery and human fallback.
- [ ] Run review-code against this plan and the implementation diff; iterate until no material findings remain.
- [ ] Capture validation evidence and review findings in the review artifact.

## Acceptance Criteria

1. `Escalated` and `Blocked` are both canonical project statuses, with `Blocked` reserved for human fallback after escalation cannot safely recover.
2. Specify, Implement, Review, and eligible infrastructure/runtime phase failures enter Escalation Manager in the same workflow, worktree, and branch.
3. Escalation Manager uses `gpt-5.4` with high reasoning without changing normal phase agent profiles.
4. Successful escalation recovery validates, comments, commits/pushes when needed, updates the existing PR when available, and returns to the correct phase intake status.
5. Review recovery supports both code/spec recovery through `Ready` and long-term review-only recovery through `In review`.
6. Human fallback writes operator-facing summary-plus-PR-link comments before moving to `Blocked`, preserves the worktree, and keeps existing human retry signals usable.
7. Programmatic enforcement prevents the agent from directly changing statuses, creating independent branches, approving/merging PRs, closing issues, bypassing phase workflow, or choosing arbitrary resume statuses.
8. Attempt limits and validation gates prevent escalation loops and cap advanced-model cost.
9. Unit, workflow, intake, fake-agent, and live fake-agent E2E coverage prove the new paths.

## Validation Strategy

- Start each task with focused failing tests where practical.
- Prefer targeted Mocha suites after each task before running repo-wide checks.
- Run `make check` before review and before final handoff.
- Run live fake-agent E2E after the fake harness supports escalation status sequences.
- Treat live real-agent validation as optional unless explicitly requested, because the escalation profile is intentionally higher-cost.