# e2e

Live GitHub-backed end-to-end tests for the `orchestrator` package.

## What it covers

The runner seeds a real GitHub issue into a Project v2, starts a local Temporal test environment, runs the orchestrator workflow, verifies the issue moves through `Ready -> In progress -> In review`, checks that a PR/comment were created, and optionally cleans everything up.

## Modes

- `live:fake` uses a deterministic fake agent and still talks to real GitHub + local Temporal.
- `live:real` runs the real agent path and verifies real PR metadata against GitHub.

## Required environment

- `E2E_TARGET_REPO` — `owner/name`
- `E2E_PROJECT_OWNER` — GitHub user or org login that owns the Project v2
- `E2E_PROJECT_NUMBER` — Project v2 number
- `GITHUB_TOKEN` or `GH_TOKEN`

Optional flags:

- `E2E_CLEANUP` — `true`/`false`, defaults to `true`
- `E2E_PRESERVE_ON_FAILURE` — `true`/`false`, defaults to `true`

`E2E_AGENT_MODE` is set by the npm script (`live:fake` or `live:real`).

## Workspace install

This repo uses npm workspaces so you can install from the repo root with a single lockfile and workspace-aware commands. npm may still manage workspace-local `node_modules`, so do not manually delete them unless you plan to reinstall.

From the repo root:

- `npm install`
- `npm --workspace e2e test`
- `npm --workspace e2e run build`
- `npm --workspace e2e run live:fake`
- `npm --workspace e2e run live:real`

## Notes

- `live:real` assumes your local Codex/OpenAI auth is already working for the orchestrator runtime.
- Cleanup closes the created issue/PR, removes the project item, and deletes the branch when enabled.
- On failures, artifacts are preserved when `E2E_PRESERVE_ON_FAILURE=true`.