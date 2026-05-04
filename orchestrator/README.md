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
- repos may register explicit project-extension quality gates that run via `zsh -c`; when no explicit gates are registered, the fallback remains repo-aware: run `make check` when a root `Makefile` declares `check`, otherwise run `npm run check` when a root `package.json` declares it, otherwise treat the repo as having no configured gate
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

The worker reads Temporal settings from the shared config layer and registers the orchestrator activities.

Scheduled pickup is also **enabled by default** on worker startup. The worker ensures the Temporal schedule `pickup-schedule` exists, uses skip-overlap behavior, and triggers an immediate pickup tick when the schedule is first created.

Use the config `pickup` block to disable or tune it:

- `pickup.enabled` — set to `false` to opt out
- `pickup.intervalSeconds` — schedule cadence (defaults to `10`)
- `pickup.maxConcurrent` — max start/signal actions per tick (defaults to `5`)

Quick operator summary:

- `npm start` starts the worker and bootstraps scheduled pickup automatically
- `pickup.enabled = false` disables schedule creation on startup
- `pickup-schedule` is the stable Temporal schedule id used by the worker
- `npm run workflow -- ...` remains the manual/one-off intake entrypoint
- Temporal UI current details now show phase state plus recent assistant-authored progress summaries from agent execution
- raw tool-use / tool-result noise is intentionally filtered out of the Temporal UI summary stream
- for the live GitHub harness, see `../e2e/README.md`

### Start a workflow run

You can configure the worker/client with a TypeScript config file.

- canonical name: `orchestrator.config.ts`
- donor-compatible alias: `night-shift.config.ts`
- sample file: copy the TypeScript example below into `orchestrator.config.ts`

Configuration precedence for selecting the config file:

1. `--config <path>` (also supports `--config=<path>`)
2. `ORCHESTRATOR_CONFIG` env override
3. `NIGHT_SHIFT_CONFIG` env override
4. discovered config file in the current working directory

If the selected config file lives next to a `.env`, that `.env` is loaded before the config file is imported.

Example config:

```ts
import { defineOrchestratorConfig } from './src/config';

export default defineOrchestratorConfig({
  git: { branchPrefix: 'orchestrator' },
  pickup: { enabled: true, intervalSeconds: 10, maxConcurrent: 5 },
  targets: [
    {
      id: 'main-repo',
      project: { owner: 'your-org', number: 123 },
      repo: { owner: 'your-org', name: 'main-repo' },
    },
  ],
});
```

Key config fields:

- `temporal.address` — Temporal endpoint, defaults to `localhost:7233`
- `temporal.namespace` — Temporal namespace, defaults to `default`
- `temporal.taskQueue` — worker/client task queue, defaults to `orchestrator`
- `intake.maxActions` — default max actions for manual `pickup` CLI runs, defaults to `1`
- `pickup.enabled` — whether worker startup creates/updates `pickup-schedule`, defaults to `true`
- `pickup.intervalSeconds` — pickup schedule cadence, defaults to `10`
- `pickup.maxConcurrent` — max pickup start/signal actions per schedule tick, defaults to `5`
- `git.branchPrefix` — naming prefix for generated branches
- `targets[].id` — stable logical target name used for selection and error reporting
- `targets[].project.owner` / `targets[].project.number` — GitHub Project v2 coordinates monitored for that target
- `targets[].repo.owner` / `targets[].repo.name` — expected repository binding for issues selected from that target

Target selection precedence is:

1. explicit CLI project owner/number
2. `GITHUB_PROJECT_OWNER` / `GITHUB_PROJECT_NUMBER`
3. the only configured target, when `targets[]` has length `1`

If multiple targets exist and no selector is provided, startup/manual intake fails fast with a clear target-selection error.

The configured repo binding is enforced before automation starts. If a selected board item belongs to a different repository than the chosen target, the run fails explicitly instead of silently acting on the wrong repo.

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

Or point either entrypoint at a specific config file:

```bash
cd orchestrator
npm start -- --config ./orchestrator.config.ts
npm run workflow -- --config ./orchestrator.config.ts pickup
```

Optional overrides:

- `GITHUB_READY_STATUS`
- `GITHUB_IN_REVIEW_STATUS`
- `GITHUB_BLOCKED_STATUS`
- `GITHUB_BRANCH_PREFIX`
- `GITHUB_PICKUP_MAX_ACTIONS`

## Repo-local project extensions

Each cloned repo may provide `.orchestrator/project.extension.ts`.

Trust model: monitored repos are trusted to provide project-extension code and shell quality gates with the same authority the orchestrator already uses to clone, edit, and validate those repos.

Authoring shape:

```ts
export default defineProjectExtension((project) => {
  project.prompt('implement').prepend('Use pnpm commands in this repo.');
  project.prompt('review').append('Check the docs examples touched by the diff.');
  project.qualityGate('typecheck', { run: 'pnpm typecheck' });
  project.qualityGate('test', { run: 'pnpm test -- --runInBand' });
});
```

Behavior notes:

- the extension is loaded once per target run after the repo worktree exists
- prompt contributions affect only the phase user prompt body in a dedicated project-extension guidance section
- system prompts and prompt-hardening wrappers remain orchestrator-owned and immutable
- explicit quality gates run from the worktree via `zsh -c <run>` in registration order
- when the extension registers zero quality gates, the fallback remains `make check` / `npm run check` autodetection
- invalid extension code fails only that target run; it does not take down unrelated configured targets

Value precedence for client/manual intake is:

1. positional CLI arguments
2. `GITHUB_*` environment variables
3. resolved config file values
4. built-in defaults

Temporal address/namespace precedence is:

1. `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`
2. resolved config file values
3. SDK defaults (`localhost:7233`, `default`)

`taskQueue` comes from the resolved config file and defaults to `orchestrator`.

`e2e` remains a deliberate temporary exception for this task: it still uses `e2e/src/config.ts` and its existing `E2E_*` environment-variable contract instead of the new shared config loader.

### Common run recipes

From `orchestrator/`:

```bash
npm start
npm start -- --config ./orchestrator.config.ts
npm run workflow -- <project-owner> <project-number> pickup 1
npm run workflow -- <project-owner> <project-number> Backlog
npm run workflow -- <project-owner> <project-number> Escalated
```

From the repo root:

```bash
make worker
make workflow ARGS="<project-owner> <project-number> pickup 1"
make check
```

### Useful verification commands

```bash
cd orchestrator
npm test
npm run build
npm run lint
```

### Live provider smoke scripts

These donor-parity smoke scripts live under `scripts/` and intentionally hit the
current provider/session boundary from Tasks 7–9 rather than recreating the
donor repo's older adapter layout.

From `orchestrator/`:

```bash
npm run smoke:claude
npm run smoke:codex
npm run smoke:output-schema
npm run smoke:tools
```

- Claude smokes require `ANTHROPIC_API_KEY`.
- Codex smokes require `OPENAI_API_KEY`.
- `smoke:output-schema` and `smoke:tools` run both Codex and Claude.
- `smoke:claude` covers the current-main equivalent of the donor's
  `runStreamed()` smoke by asserting `onEvent` provider-item traces because the
  shared `AgentSession` seam intentionally exposes `run()` rather than a
  separate streaming method.
- `smoke:tools` uses raw `provider-item` traces from the current session API as
  the current-main equivalent of the donor's tool-use/tool-result streaming
  checks.

### Eval fixture world-model

- `eval/demo/PROJECT.md` is the current-main equivalent of donor
  `eval/demo/PROJECT.md`.
- Use it as shared fictional product context when authoring eval fixtures.

## Small architecture map

- `src/worker.ts` — starts the Temporal worker and registers activities
- `src/client.ts` — runs shared pickup/manual intake from the command line
- `src/intake.ts` — shared start/signal/noop trigger resolution and pickup batching
- `src/workflows.ts` — deterministic phased workflow shell
- `src/activities.ts` — contains GitHub API calls, local git/worktree logic, Codex invocation, PR creation, and cleanup
- `src/shared.ts` — shared constants and types

## A few implementation details worth remembering

- `Escalated` means Night Shift is attempting automated recovery in the same workflow, worktree, and branch
- `Blocked` now means escalation has already produced a human handoff and the workflow is waiting for an operator decision
- pickup scans `Backlog` and `Ready` only; `Escalated` is recovery-only and must belong to an already-open workflow
- manual intake may target `Escalated`, but it will only inspect or signal an open workflow and will not start a detached one
- issue comments are marker-upserted; the main escalation markers are `escalation:summary`, `escalation:human-needed`, and `workflow:phase-failure`
- Local repository state is cached under `/tmp/orchestrator`
- Branches are stable per issue, using `orchestrator/issue-<number>` by default
- Worktrees are also stable per issue, which helps with retries/recovery
- Workflow ids are stable per issue, using `ticket-<issueNumber>`
- `runAgent` uses local Codex with model `gpt-5.3-codex` and low reasoning effort
- the reserved Escalation Manager profile uses `gpt-5.4` with high reasoning, bounded attempts, and is intended only for rare escalation-recovery paths
- The issue body is used as the task description sent to Codex
- The old dummy file writer still exists separately for future E2E testing
