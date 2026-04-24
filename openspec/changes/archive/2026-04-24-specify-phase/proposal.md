# Change: specify-phase

## Why

The orchestrator's first phase needs to turn a raw ticket (GitHub issue on
a Projects v2 card) into a reviewable spec. Today we have typed contracts
(`SpecifierInput` / `SpecifierOutput`), an agent adapter that can drive
Codex, and a GitHub client that can read issues and transition project
statuses — but no code that composes them into the Specify phase described
in `openspec/project.md` (M1 baseline flow).

Without this phase there is no machine-readable `ChangeSpec` to hand off to
Implement, no automatic transition `Backlog → Refinement → Refined`, and
no way to surface open questions back to the human on the ticket. This
change closes that gap.

## What Changes

- Adds a new capability `specify-phase`: `runSpecifyPhase(input, deps): Promise<SpecifyResult>`
  plus a thin CLI entry point. `SpecifyResult` is a discriminated union of
  `{status: "refined", bundle: SpecBundle}` and `{status: "needs_input", openQuestions}`.
- Reads the ticket from GitHub via `GitHubClient.getItem` + `getIssue` and
  assembles a `SpecifyInput` (the `Ticket` contract).
- Before generation: transitions the project item `Backlog → Refinement`
  and creates the branch `branchNameFor(ticket)` off the default branch via
  `GitHubClient.createBranch` (idempotent).
- Calls the specifier `AgentAdapter` (configured via `NightShiftConfig`)
  with a structured prompt and parses the response into an OpenSpec change
  folder (`proposal.md`, `design.md`, `specs/<cap>/spec.md`, `tasks.md`)
  plus an optional `openQuestions[] / assumptions[] / risks[]` block.
- Writes the change folder at `openspec/changes/<ticket-id>-<slug>/`,
  commits it to the ticket branch via `git` (through an injectable
  `GitOps` dep, with an in-memory fake for tests), and records the
  resulting commit sha.
- Validates with `openspec validate <name> --strict`; on failure retries
  the LLM once, then returns `status: "needs_input"` with the validator
  errors surfaced as open questions.
- Upserts a ticket comment (marker `specify:summary`) linking to the
  change folder and listing open questions / assumptions / risks.
- On success (no open questions) transitions the item `Refinement → Refined`
  and returns the validated `SpecBundle`. On any `needs_input` outcome
  (open questions from the specifier OR validator errors after retry)
  transitions the item to the new `Blocked` status so a human can act on
  the ticket comment. Both `Blocked` and `Refined` are terminal for this
  phase: to continue, the human replies on the ticket and manually moves
  the item back to `Backlog` (operator unblocking, or reviewer requesting
  a revision). The orchestrator picks it up and the phase runs the normal
  `Backlog → Refinement` entry. Invoking the phase on a `Blocked` or
  `Refined` item directly is rejected.
- Reads the issue's comment history (`github.listComments`) and
  includes every non-Night-Shift comment in the specifier prompt so
  human replies posted after a previous terminal outcome are available
  on the next attempt. When an existing change folder is present on
  the ticket branch, its files are also fed into the prompt as a
  `## Current draft` revision base. (Adds `listComments` to the
  `GitHubClient` surface.)
- Extends the canonical `StatusName` enum with a new value `Blocked`
  (added at the end so existing option ordering is preserved) and teaches
  `createGitHubClient` to auto-create it under `manageStatusOptions`
  like the other seven.
- Adds `InMemoryFakeGitOps` and wires the phase tests against the existing
  `InMemoryFakeGitHubClient` + `InMemoryFakeAgentAdapter`.

## Impact

- **Affected specs:** new capability `specify-phase`; the `github-integration`
  capability is modified to add `Blocked` to the canonical status set and
  to add `listComments` to the client surface; the `agent-adapter`
  capability is modified to document `TurnOpts.outputSchema`.
- **Affected code:** new module `src/phases/specify/` (first sibling under
  `src/phases/`); extends `scripts/check-boundaries.mjs` with a `phases`
  rule; adds a `night-shift specify <itemId>` CLI in `src/cli/`; adds
  `src/git/` (tiny wrapper + in-memory fake) consumed only by phases.
- **Non-goals:** scheduling, retries across process restarts, webhook
  routing, PR creation, quality gates, and the Implement/Review phases
  are out of scope — they live in their own changes (#5, #6, #7).
