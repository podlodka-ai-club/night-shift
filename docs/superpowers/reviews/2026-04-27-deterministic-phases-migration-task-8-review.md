# Task 8 AI Review Artifact

## Scope

Task 8 from `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-8.md`:
- implement pickup/manual intake only (explicitly excluding webhook support)
- add a shared trigger-resolution layer for start vs signal vs noop decisions
- use deterministic per-issue workflow ids so repeated intake is idempotent
- update the client and fake-agent E2E harness to use the intake-driven start path
- preserve original phase failures even when blocked cleanup fails and guard signal races

## Review progression

Review pass progression on this task:
- pass 1 found missing trigger-table coverage and a redundant second sort in `runPickupIntake`; both were fixed
- pass 2 requested direct `buildManualCandidate` coverage and a repeated-pickup idempotency test; both were added
- pass 3 found one real bug: cleanup failures in `handlePhaseFailure` could mask the original phase error, plus a signal-race guard gap; both were fixed and regression-tested
- final pass (`.ai/reviews/diff-only/20260428T200510345103Z/review.md`) reported **no blockers remain for this branch**

Final reviewer confirmation:
- AC1/AC2 satisfied: `Backlog` starts `Specify`; `Ready` starts `Implement`
- AC3 satisfied: blocked workflow signals follow the copied board-status/blocked-reason contract
- AC4 satisfied: pickup merges `Backlog` + `Ready`, sorts by `createdAt`, and respects a shared action cap
- AC5/AC6 satisfied: unit + workflow-level tests cover start/signal/noop, duplicate-start races, repeated pickup ticks, and signal-vs-duplicate behavior
- AC7 satisfied: webhook support remains excluded; the client only exposes pickup/manual intake

## Residual follow-ups

No blocking findings remain.

Low-priority follow-ups still tracked in `.ai/tech-debt.md`:
- review-phase failure comments still suggest `Ready` instead of `In review`
- discarded signals are not surfaced in `shellState.latestActivity`
- `client.ts` does not unwind `.cause` chains when logging top-level errors
- `cleanupWorktree` remains unused and should be resolved in Task 9

## Validation evidence

Successful local verification:
- `make check`
- focused intake/activity/workflow regression suites while implementing the task
- repeated review reruns ending with `.ai/reviews/diff-only/20260428T200510345103Z/review.md` reporting no blockers

## Live fake-agent E2E evidence

The prescribed Task 8 live fake-agent intake path succeeded on 2026-04-28 with:
- repo: `Mugenor/orchestrator-testing`
- project: `https://github.com/users/Mugenor/projects/1`
- active GitHub auth: `Mugenor`
- command: `npm --workspace e2e run live:fake`

Observed result:
- run id: `ee902473`
- issue: `https://github.com/Mugenor/orchestrator-testing/issues/52`
- PR: `https://github.com/Mugenor/orchestrator-testing/pull/53`
- workflow id: `ticket-52`
- statuses: `Ready -> In progress -> In review -> Ready -> In progress -> In review -> Ready to merge`
- cleanup attempted: close PR, close issue, delete project item, delete branch
- cleanup failures: none