# TaskFlow — demo project for the eval fixture harness

This is the current-main equivalent of donor `eval/demo/PROJECT.md`.
The content is a direct port, but it now lives under `orchestrator/eval/demo/`
because the eval harness and fixtures live in the `orchestrator` workspace.

A small fictional product used as the *world-model* for eval fixtures.
Specifier and implement prompts that reference TaskFlow features should
plausibly find context here.

## Product summary

TaskFlow is a self-hosted CLI + REST API for personal task tracking.

- **CLI**: `tf add "buy milk" --tag groceries --due tomorrow`, `tf list --tag groceries`, `tf done 7`.
- **Server**: TypeScript / Fastify, single-binary deploy, SQLite backend.
- **Sync**: optional WebDAV sync of the SQLite file across devices.
- **Auth**: single user; bearer token configured in `~/.taskflow/config.toml`.

## Architecture (single repo, monorepo-light)

```text
taskflow/
  packages/
    cli/
    server/
    shared/
  apps/
    web/
  scripts/
    migrate.ts
```

## Domain entities

- **Task**: `{ id: number; title: string; tag?: string; due?: ISO date; status: "open" | "done"; createdAt: ISO; recurrence?: RecurrenceRule }`
- **Tag**: free-form lowercase string, max 32 chars.
- **RecurrenceRule**: `{ kind: "daily" | "weekly" | "monthly"; interval: number }`.

## Known constraints

- SQLite path is hard-coded to `~/.taskflow/db.sqlite`.
- WebDAV sync is best-effort; conflicts resolve last-write-wins by `updatedAt`.
- The CLI bundles its own Node runtime and ships as a standalone tarball.
- The shared package is published privately to a Verdaccio registry.

## Style / contributor expectations

- TS strict mode, `exactOptionalPropertyTypes: true`.
- Public APIs validated with Zod at the boundary.
- No floating-point math for due-date logic; use UTC helpers.
- Every PR ships with at least one test for the changed behaviour.

## Out of scope

- Multi-user accounts.
- Mobile apps.
- Full-text search across task bodies.
- Calendar (ICS) integrations.