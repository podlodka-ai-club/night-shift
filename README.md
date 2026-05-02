# agent-orchestrator

This repository currently centers on the Temporal-based GitHub issue orchestrator in `orchestrator/`.

## What it does

The orchestrator picks the top `Ready` issue from a GitHub Project v2, moves it to `In progress`, creates or reuses a local git worktree, runs Codex locally against the target repository, commits and pushes changes, opens or reuses a pull request, comments on the issue, and finally moves the item to `In review`.

Scheduled pickup is enabled by default when the worker starts, so `Backlog` / `Ready` items can be started or resumed automatically through Temporal.

## Docs map

- `orchestrator/README.md` — main operator guide: worker startup, config loading, manual intake, and scheduled pickup behavior
- `e2e/README.md` — live GitHub-backed verification harness, including fake, real, and pickup-driven runs
- `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-11.md` — Task 11 delivery/spec doc for donor-style scheduled pickup

## Quick commands

From the repo root:

- `make help`
- `make worker`
- `make workflow ARGS="<project-owner> <project-number> pickup 1"`
- `make e2e-live-fake-pickup`
- `make check`

If you prefer package-local commands, see `orchestrator/README.md` and `e2e/README.md`.
