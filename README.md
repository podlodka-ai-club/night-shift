# agent-orchestrator

This repository currently centers on the Temporal-based GitHub issue orchestrator in `orchestrator/`.

## What it does

The orchestrator picks the top `Ready` issue from a GitHub Project v2, moves it to `In progress`, creates or reuses a local git worktree, runs Codex locally against the target repository, commits and pushes changes, opens or reuses a pull request, comments on the issue, and finally moves the item to `In review`.

## Where to start

- Main project: `orchestrator/`
- Detailed docs: `orchestrator/README.md`

## Quick commands

From `orchestrator/`:

- `npm install`
- `npm start`
- `npm run workflow -- <project-owner> <project-number>`
- `npm test`
