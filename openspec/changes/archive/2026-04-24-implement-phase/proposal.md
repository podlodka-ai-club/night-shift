## Why

Milestone 1 needs the middle phase that turns a validated `SpecBundle`
into a reviewable pull request. Without it, the refined tickets produced
by `specify-phase` have nowhere to go — the orchestrator has nothing to
schedule, and the review phase has no PR to read. This change ships the
`implement-phase` module so `Ticket ──▶ [ Specify ] ──▶ [ Implement ]`
works end-to-end against the dogfooding repo.

## What Changes

- Adds `runImplementPhase(input, deps): Promise<ImplementResult>` that:
  - Accepts an `ImplementInput` (`{ ticket, specBundle }`) as already
    defined by the `phase-contracts` capability.
  - Transitions the project item `Ready → In progress` at entry and
    `In progress → In review` on success. Rejects items not in `Ready`
    (or `In progress` for crash-recovery idempotency) with a typed
    error. Escalation on repeated failure transitions to `Blocked` and
    lets the human move the ticket back to `Ready` to retry, matching
    the `specify-phase` Backlog-reset pattern.
  - Provisions a fresh `git worktree` at
    `.night-shift/worktrees/<ticket-id>/` from the ticket branch
    produced by `specify-phase`. The worktree is removed on success and
    kept on failure (operator debugging) — a TTL sweeper is left for
    the orchestration runtime change.
  - Runs the implementer agent (role `implementer`) inside the worktree
    via the existing `AgentAdapter`, passing the spec bundle files and
    ticket context and forcing a structured JSON response that lists
    the summary, touched files, and self-reported risks.
  - Runs a subagent "spec-review" pass (role `spec-reviewer`) that reads
    the diff vs the ticket branch base plus `SpecBundle` files and
    returns a structured list of blocking issues; any blocking issue
    triggers one implementer retry with the feedback appended.
  - Executes the configured quality gates (default `tsc --noEmit` +
    `test` + `lint`, configurable via `NightShiftConfig.qualityGates`)
    in the worktree. Each gate produces a `QualityGateResult`; a single
    `failed` gate triggers one implementer retry that receives the
    `logsTail`. After retry exhaustion the phase returns
    `status: "needs_input"` with the gate failures as open questions.
  - Commits all changes on the ticket branch via the existing `GitOps`
    surface from `specify-phase`, pushes through the GitHub client, and
    opens (or updates) a pull request via `github.openPullRequest`. The
    PR body is generated from the spec bundle + quality-gate summary
    and upserted on retries (no duplicate PRs).
  - Upserts a `implement:summary` marker comment on the ticket with the
    PR link, gate table, and spec-review findings.
  - Emits `phase.started` / `phase.finished` events with
    `phase: "implement"` using the existing `events` contract.
- Adds an `implementer` and `spec-reviewer` role to the canonical
  `AgentRole` enum (keeping the existing `specifier` / `reviewer`
  values).
- Adds a `night-shift implement <projectItemId>` CLI exposing the phase,
  with exit codes mirroring `specify-phase` (`0` PR opened,
  `1` needs_input, `2` error, `64` usage).
- Adds a `src/worktree/` module (tiny wrapper around `git worktree add/remove`
  + an in-memory fake) and a `src/quality-gates/` module (config-driven
  command runner + fake) so unit tests can exercise the phase without
  shelling out.
- Extends `scripts/check-boundaries.mjs` with `worktree`, `quality-gates`,
  and widens the existing `phases` rule to allow those new siblings.

## Capabilities

### New Capabilities
- `implement-phase`: the orchestrated flow that takes a `SpecBundle`,
  runs the implementer + spec-review + quality gates inside a
  dedicated worktree, opens a PR, and transitions the GitHub project
  item accordingly.

### Modified Capabilities
- `github-integration`: adds `pushBranch` and `upsertPullRequest`
  surfaces to the `GitHubClient` (the existing `openPullRequest` is
  extended to be idempotent by branch name).
- `agent-adapter`: extends the canonical `AgentRole` enum with
  `implementer` and `spec-reviewer` so `NightShiftConfig.roles` can
  carry provider/model settings for them.

## Impact

- **Affected specs:** new `implement-phase` capability; `github-integration`
  and `agent-adapter` modified.
- **Affected code:** new `src/phases/implement/`, `src/worktree/`,
  `src/quality-gates/`; adds `night-shift implement` CLI under
  `src/cli/`; extends `scripts/check-boundaries.mjs`.
- **Affected dependencies:** reuses `simple-git` (already added for
  `specify-phase`); no new runtime deps.
- **Non-goals:** review phase (separate change), Temporal
  orchestration (separate change), automatic worktree TTL cleanup
  (handled by orchestration runtime), conflict resolution when the
  ticket branch has diverged from base.
