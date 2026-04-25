# `src/contracts/`

Shared phase contracts for Night Shift's baseline flow (Specify → Implement → Review).

This module defines the **types + runtime validators** every other module of Night Shift depends on. Keeping this layer minimal and boundary-pure is what lets the three phases stay independent.

## Exports

- **Ticket model** — `Ticket`, `TicketSchema`, `SourceRef`, `GitHubSourceRef`
- **Status & transitions** — `TICKET_STATUSES`, `TicketStatus`, `TICKET_STATUS_TRANSITIONS`, `canTransition(from, to)`
- **Helpers** — `slugify`, `branchNameFor(ticket)`, `usdToMicro`, `microToUsd`
- **Specify contract** — `SpecifyInput`, `SpecBundle`, `validateSpecBundle(ticket, bundle)`
- **Implement contract** — `ImplementInput`, `ImplementationResult`, `QualityGateResult`, `PRRef`
- **Review contract** — `ReviewInput`, `ReviewResult`, `Finding`, `Verdict`, `decideVerdict(findings, iteration, maxIterations?)`
- **Observability** — `PhaseEvent` discriminated union, `EventSink` interface

## What NOT to import here

`src/contracts/**` must remain boundary-pure:

- ❌ No Temporal, Octokit, agent SDKs
- ❌ No `node:fs`, `node:child_process`, network APIs
- ❌ No environment variables or config reads
- ❌ No `Date`, `bigint`, `Map`, `Set`, functions — contracts must round-trip JSON

Only `zod` and sibling `./*.ts` imports are allowed. Enforced by [`scripts/check-contracts-imports.mjs`](../../scripts/check-contracts-imports.mjs) (`npm run lint:contracts`).

## Spec

See [openspec/changes/phase-contracts/specs/phase-contracts/spec.md](../../openspec/changes/phase-contracts/specs/phase-contracts/spec.md).
