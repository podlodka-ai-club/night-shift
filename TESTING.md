# Feature Factory – MVP Testing Strategy

## Overview

The MVP uses three testing layers, matching the complexity of each component:

| Layer | Scope | Tool | When |
|-------|-------|------|------|
| Unit | Pure logic with no I/O | Vitest | On every change |
| Contract | Adapter interfaces with fixtures/mocks | Vitest | On every change |
| Integration (dry-run) | End-to-end worker flow against stubs | Vitest | Before demos / CI |

## Unit Tests (`tests/unit/`)

Cover components that do not touch the network, GitHub, or LLM APIs:

- **RunStore** – state lifecycle, locking/resume, event append, usage append.
- **AgentRunner** – role routing, cost estimation, budget enforcement, provider credential checks, and provider adapter dispatch.
- **ValidationRunner** – config parsing, happy path, missing config error, failing command.
- **config** – env-based config loading and defaults.
- **resume** – deriveResumeStage logic across stage/evidence combinations.
- **summarizer** – RunSummary model, buildRunSummary, format resolution, TTY detection.
- **RepoWorkspace** – branch/worktree setup helpers.
- **ReportPublisher** – PR creation and milestone comment formatting.
- **implementStage** – implement stage orchestration with mocked context.
- **reviewStage** – review stage orchestration with mocked context.

## Contract Tests (`tests/contract/`)

Validate the adapter *interfaces* without hitting live APIs:

- **GitHubAdapter** – mock `@octokit/graphql` and `@octokit/rest`; verify correct GraphQL
  queries for item listing, correct mutation calls for status updates, and correct REST
  calls for comments and PRs.

## Integration Tests (`tests/integration/`)

Scripted dry-run scenarios that exercise the full worker state machine with:

- All external I/O (GitHub, Anthropic SDK, Codex SDK, git) replaced by lightweight stubs.
- Real `RunStore` writes to a temp directory.

Scenarios covered:

1. **Happy path** – claim → specify → implement → validate → pr_opened → review → complete.
2. **Blocked on missing validation config** – worker blocks with the correct reason.
3. **Crash recovery** – write a mid-flight state.json, restart worker, verify it resumes from the correct stage.

## Running Tests

```bash
npm test           # all tests (vitest run)
npm run test:watch # watch mode
npm run typecheck  # TypeScript check
npm run check      # typecheck + tests
```

## What is NOT tested in the MVP

- Real LLM output quality (tested manually during sprint demos).
- GitHub Projects v2 GraphQL live calls (tested against a real project in smoke tests).
- git worktree operations end-to-end (verified by running the orchestrator on a real repo).
