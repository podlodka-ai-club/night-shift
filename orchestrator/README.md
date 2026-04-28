# GitHub Issue Orchestrator

## What it is

This is a Temporal-based automation service for GitHub Project v2 issue handling.

Its steady-state model is a **deterministic phased workflow**:

1. `Specify` turns a `Backlog` issue into an OpenSpec draft and waits for approval if needed.
2. `Implement` applies an approved change in a stable per-ticket worktree and opens/updates a PR.
3. `Review` evaluates the PR against the spec and either approves, requests fixes, or escalates.

Shared intake (`pickup` or `manual`) decides whether a board item should **start**, **signal**, or **noop** based on the current board status plus any blocked workflow state.

## High-level workflow

For each selected issue, the steady-state flow is:

1. Intake scans `Backlog` and `Ready` items, or manually selects `Backlog` / `Ready` / `In review`
2. Intake resolves one of:
   - start `specify`
   - start `implement`
   - signal a blocked workflow
   - noop
3. The phased workflow keeps deterministic state under workflow id `ticket-<issueNumber>`
4. Non-deterministic work stays in activities:
   - GitHub reads/writes
   - worktree/git operations under `/tmp/orchestrator`
   - agent execution via `runAgentSequence`
5. On full success (`Ready to merge`), the local per-ticket worktree is cleaned up
6. On blocked or failing paths, the worktree is intentionally preserved for debugging/resume

Operational defaults:

- per-ticket branches/worktrees are stable and reusable across retries
- automation uses a normal `git push -u origin <branch>` policy and does **not** force-push
- corrupt pre-existing worktrees are recreated instead of being trusted blindly
- the generic intake layer and generic `runAgentSequence` activity are intentional steady-state seams beneath the donor-style phase state machine

## Project board status model

The orchestrator now normalizes the GitHub Project `Status` field to the donor-compatible set before selecting work:

- `Backlog`
- `Refinement`
- `Refined`
- `Ready`
- `In progress`
- `In review`
- `Ready to merge`
- `Blocked`

Missing canonical options are created idempotently during project lookup so the current `Ready -> In progress -> In review` path can keep running against the richer board vocabulary.

## Run locally

### Prerequisites

- Node.js / npm
- A local Temporal server reachable at `localhost:7233`
  - for example, via `temporal server start-dev`
- A GitHub token available as `GITHUB_TOKEN` or `GH_TOKEN`
- Local `codex` CLI installed and authenticated

### Install

```bash
cd orchestrator
npm install
```

### Start the worker

```bash
cd orchestrator
npm start
```

The worker connects to Temporal at `localhost:7233` and registers the orchestrator activities.

### Start a workflow run

You can pass the GitHub project owner/number directly:

```bash
cd orchestrator
npm run workflow -- <project-owner> <project-number> [pickup|Backlog|Ready|"In review"] [max-actions]
```

Modes:

- `pickup` (default): scan `Backlog` + `Ready`, merge by `createdAt`, and process up to `max-actions`
- `Backlog`: manually intake one `Backlog` issue
- `Ready`: manually intake one `Ready` issue
- `In review`: manually intake one `In review` issue

Or provide project coordinates through environment variables:

- `GITHUB_PROJECT_OWNER`
- `GITHUB_PROJECT_NUMBER`

Optional overrides:

- `GITHUB_READY_STATUS`
- `GITHUB_IN_REVIEW_STATUS`
- `GITHUB_BLOCKED_STATUS`
- `GITHUB_BRANCH_PREFIX`
- `GITHUB_FILE_PATH_PREFIX`
- `GITHUB_PICKUP_MAX_ACTIONS`

### Useful verification commands

```bash
cd orchestrator
npm test
npm run build
npm run lint
```

## Small architecture map

- `src/worker.ts` — starts the Temporal worker and registers activities
- `src/client.ts` — runs shared pickup/manual intake from the command line
- `src/intake.ts` — shared start/signal/noop trigger resolution and pickup batching
- `src/workflows.ts` — deterministic phased workflow shell
- `src/activities.ts` — contains GitHub API calls, local git/worktree logic, Codex invocation, PR creation, and cleanup
- `src/shared.ts` — shared constants and types

## A few implementation details worth remembering

- Local repository state is cached under `/tmp/orchestrator`
- Branches are stable per issue, using `orchestrator/issue-<number>` by default
- Worktrees are also stable per issue, which helps with retries/recovery
- Workflow ids are stable per issue, using `ticket-<issueNumber>`
- `runAgent` uses local Codex with model `gpt-5.3-codex` and low reasoning effort
- The issue body is used as the task description sent to Codex
- The old dummy file writer still exists separately for future E2E testing
