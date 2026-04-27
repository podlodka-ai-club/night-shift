# GitHub Issue Orchestrator

## What it is

This is a small Temporal-based automation service for GitHub Project v2 issue handling.

Today, its main job is to take the top `Ready` issue from a project, run a local coding agent against the target repository, and do the pull request plumbing around that work.

## High-level workflow

For each selected issue, the workflow currently does this:

1. Query the GitHub Project v2 and pick the first issue in `Ready`
2. Move that project item to `In progress`
3. Create or reuse a stable local clone/worktree under `/tmp/orchestrator`
4. Run local `codex exec` with the issue description as the task prompt
5. Stage all worktree changes, commit them, and push the branch
6. Open a pull request, or reuse an existing open PR for the same branch
7. Comment on the GitHub issue with the PR URL
8. Move the project item to `In review`
9. Clean up the local worktree

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
npm run workflow -- <project-owner> <project-number>
```

Or provide them through environment variables:

- `GITHUB_PROJECT_OWNER`
- `GITHUB_PROJECT_NUMBER`

Optional overrides:

- `GITHUB_READY_STATUS`
- `GITHUB_IN_REVIEW_STATUS`
- `GITHUB_BRANCH_PREFIX`
- `GITHUB_FILE_PATH_PREFIX`

### Useful verification commands

```bash
cd orchestrator
npm test
npm run build
npm run lint
```

## Small architecture map

- `src/worker.ts` — starts the Temporal worker and registers activities
- `src/client.ts` — starts a workflow execution from the command line
- `src/workflows.ts` — defines the high-level orchestration flow
- `src/activities.ts` — contains GitHub API calls, local git/worktree logic, Codex invocation, PR creation, and cleanup
- `src/shared.ts` — shared constants and types

## A few implementation details worth remembering

- Local repository state is cached under `/tmp/orchestrator`
- Branches are stable per issue, using `orchestrator/issue-<number>` by default
- Worktrees are also stable per issue, which helps with retries/recovery
- `runAgent` uses local Codex with model `gpt-5.3-codex` and low reasoning effort
- The issue body is used as the task description sent to Codex
- The old dummy file writer still exists separately for future E2E testing
