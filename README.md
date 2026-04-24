# Night Shift

Turn tickets into reviewable PRs with measurable quality, cost, and latency — so human engineers spend their time on the work that actually needs them.

See [`openspec/project.md`](openspec/project.md) for the project context and [`openspec/changes/`](openspec/changes/) for active changes.

## Modules

- [`src/contracts/`](src/contracts/) — shared phase contracts (Ticket, I/O schemas, observability events). All downstream phases depend on this.
- [`src/adapters/`](src/adapters/) — normalised agent-SDK interface + provider adapters (Codex, Claude stub, in-memory fake). See [`src/adapters/README.md`](src/adapters/README.md).
- [`src/config/`](src/config/) — `night-shift.config.*` loader and `NightShiftConfigSchema`. See [`src/config/README.md`](src/config/README.md).
- [`src/github/`](src/github/) — typed wrappers around GitHub REST/GraphQL/webhooks for Projects v2, issues, labels, comments, branches, and PRs. See [`src/github/README.md`](src/github/README.md).
- [`src/git/`](src/git/) — minimal `GitOps` surface (real `simple-git` impl + in-memory fake). See [`src/git/README.md`](src/git/README.md).
- [`src/phases/specify/`](src/phases/specify/) — Specify phase runtime that converts a ticket into an OpenSpec change folder. See [`src/phases/specify/README.md`](src/phases/specify/README.md).
- [`src/phases/implement/`](src/phases/implement/) — Implement phase runtime that drives the implementer agent, runs quality gates in a worktree, and opens a PR. See [`src/phases/implement/README.md`](src/phases/implement/README.md).
- [`src/worktree/`](src/worktree/) — `WorktreeOps` surface for creating/removing per-ticket git worktrees. See [`src/worktree/README.md`](src/worktree/README.md).
- [`src/quality-gates/`](src/quality-gates/) — `QualityGateRunner` that executes typecheck/lint/test gates with per-gate timeouts and 4 KiB log truncation. See [`src/quality-gates/README.md`](src/quality-gates/README.md).
- [`src/cli/`](src/cli/) — CLI entry points (`night-shift specify …`, `night-shift implement …`).

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest suites
- `npm run lint:contracts` — guardrail: `src/contracts/**` imports only `zod` and siblings
- `npm run lint:boundaries` — guardrail: enforce import boundaries for `contracts`, `adapters`, `config`, `github`, `git`, `phases`, `worktree`, `quality-gates`, and `cli` modules
- `npm run specify -- --item <projectItemId> --change <change-name>` — run the Specify phase against a single project item
- `npm run implement -- --item <projectItemId> --change <change-name>` — run the Implement phase against a single project item
