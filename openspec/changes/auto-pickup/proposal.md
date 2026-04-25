## Why

Night Shift workflows are currently reactive — they only start when an operator manually runs `npm run start` or when a webhook fires from a board status change. There is no mechanism to automatically discover and process tickets sitting in the Backlog column. This means tickets can sit unprocessed until a human notices and triggers them, which defeats the "overnight automation" premise.

## What Changes

- Add a `listItemsByStatus` method to `GitHubClient` that queries a Projects v2 board for all items in a given status column.
- Add a **pickup schedule workflow** — a Temporal cron workflow that periodically scans the board for Backlog items and starts a `ticketWorkflow` for each unprocessed one.
- Add a `night-shift pickup` CLI command that runs the scan once (useful for testing and manual catch-up).
- Add config options to control pickup behavior: polling interval, max concurrent workflows, and an opt-out flag.

## Capabilities

### New Capabilities
- `auto-pickup`: Scheduled board scanning and automatic workflow triggering for unprocessed Backlog items.

### Modified Capabilities
- `github-integration`: Add `listItemsByStatus` to `GitHubClient` for querying project items by status column value.

## Impact

- **`src/github/`** — new `listItemsByStatus` method on `GitHubClient` interface + implementation (GraphQL query against Projects v2).
- **`src/orchestration/`** — new `pickup-workflow.ts` (cron workflow) and `pickup-activities.ts` (scan + start activities).
- **`src/cli/`** — new `pickup.ts` CLI entry point.
- **`src/config/`** — extend `NightShiftConfigSchema` with optional `pickup` section.
- **No breaking changes** — all additions are opt-in; existing webhook-driven flow is unchanged.
