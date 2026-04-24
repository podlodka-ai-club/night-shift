# Night Shift

Turn tickets into reviewable PRs with measurable quality, cost, and latency — so human engineers spend their time on the work that actually needs them.

See [`openspec/project.md`](openspec/project.md) for the project context and [`openspec/changes/`](openspec/changes/) for active changes.

## Modules

- [`src/contracts/`](src/contracts/) — shared phase contracts (Ticket, I/O schemas, observability events). All downstream phases depend on this. Spec: [`openspec/changes/phase-contracts/specs/phase-contracts/spec.md`](openspec/changes/phase-contracts/specs/phase-contracts/spec.md).

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest suites
- `npm run lint:contracts` — guardrail: `src/contracts/**` imports only `zod` and siblings
