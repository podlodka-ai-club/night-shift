# e2e

Live GitHub-backed end-to-end tests for the `orchestrator` package.

## What it covers

The runner seeds a real GitHub issue into a Project v2, starts a local Temporal test environment, runs the orchestrator workflow, verifies canonical board transitions, checks that PR/comment artifacts were created, and optionally cleans everything up.

## Modes

- `live:fake` uses a deterministic fake agent and talks to real GitHub + local Temporal through the default manual intake path. This manual fake scenario seeds `.orchestrator/project.extension.ts` into the temporary branch and verifies provider/model configuration end-to-end through the resulting fake workflow artifacts.
- `live:fake:pickup` uses the deterministic fake agent but starts the run through `pickupWorkflow` / scheduled-pickup semantics.
- `live:real` runs the real agent path and verifies real PR metadata against GitHub.

The fake-agent harness now also exposes deterministic escalation outputs for:

- resolved recovery back through `Ready`
- resolved review-only recovery back through `In review`
- human fallback to `Blocked`

The default live fake run still exercises the normal Ready-path. The extra escalation helpers are intended for focused unit coverage and future live escalation scenarios.

## Required environment

- `E2E_TARGET_REPO` — `owner/name`
- `E2E_PROJECT_OWNER` — GitHub user or org login that owns the Project v2
- `E2E_PROJECT_NUMBER` — Project v2 number
- `GITHUB_TOKEN` or `GH_TOKEN`

Optional flags:

- `E2E_CLEANUP` — `true`/`false`, defaults to `true`
- `E2E_PRESERVE_ON_FAILURE` — `true`/`false`, defaults to `true`
- `E2E_INTAKE_MODE` — `manual` or `pickup`, defaults to `manual`

`E2E_AGENT_MODE` is usually set by the npm script (`live:fake`, `live:fake:pickup`, or `live:real`).

If you invoke `npm --workspace e2e run live` directly, set both:

- `E2E_AGENT_MODE=fake|real`
- `E2E_INTAKE_MODE=manual|pickup`

## Workspace install

This repo uses npm workspaces so you can install from the repo root with a single lockfile and workspace-aware commands. npm may still manage workspace-local `node_modules`, so do not manually delete them unless you plan to reinstall.

From the repo root:

- `npm install`
- `npm --workspace e2e test`
- `npm --workspace e2e run build`
- `npm --workspace e2e run live:fake`
- `npm --workspace e2e run live:fake:pickup`
- `npm --workspace e2e run live:real`

Or use the repo-root Make wrappers:

- `make e2e-live-fake`
- `make e2e-live-fake-pickup`
- `make e2e-live-real`

## Notes

- `live:real` assumes your local Codex/OpenAI auth is already working for the orchestrator runtime.
- `live:fake:pickup` is the quickest live proof that the scheduled-pickup path can start/resume workflows end-to-end.
- allowed fake-agent status contracts now include escalation transitions such as `Escalated -> Ready`, `Escalated -> In review`, `Escalated -> Backlog`, and `Escalated -> Blocked` where the scenario permits them.
- Cleanup closes the created issue/PR, removes the project item, and deletes the branch when enabled.
- On failures, artifacts are preserved when `E2E_PRESERVE_ON_FAILURE=true`.