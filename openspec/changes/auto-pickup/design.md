## Context

Night Shift's `ticketWorkflow` processes a single ticket through Specify → Implement → Review. Currently workflows are started by:

1. **`npm run start`** — operator manually provides a project item ID.
2. **Webhook bridge** — GitHub Projects v2 status-change webhooks fire `handleWorkflowTrigger`, which starts a workflow when an item moves to Backlog.

There is no mechanism to discover items already sitting in Backlog or Ready when the worker starts, or to periodically check for new items that arrive without a webhook (e.g., items added directly via the GitHub UI while the worker is down).

The existing `GitHubClient` interface has `getItem(itemId)` but no method to list items by status.

There are two intake statuses:
- **Backlog** → needs the full Specify → Implement → Review flow.
- **Ready** → spec already reviewed; needs only Implement → Review. However, `ticketWorkflow` currently always starts at the Specify phase, and the Specify phase rejects items in Ready status (`STATUSES_BLOCKING_ENTRY` includes `Ready`).

## Goals / Non-Goals

**Goals:**
- Automatically discover Backlog and Ready items on the project board and start `ticketWorkflow` for each.
- Support skipping the Specify phase for items already in Ready (spec already reviewed).
- Use a Temporal cron schedule so the pickup cadence is durable, observable, and configurable.
- Deduplicate against already-running workflows (Temporal's `WorkflowExecutionAlreadyStartedError`).
- Provide a one-shot CLI (`night-shift pickup`) for manual catch-up runs.
- Make the feature opt-in with sensible defaults (5-minute interval).

**Non-Goals:**
- Smart priority ordering beyond board position (e.g., labels, weights). Items are processed in the order returned by the GraphQL query (board position), which provides a deterministic, operator-controllable ordering.
- Replacing the webhook bridge — auto-pickup is a complement, not a replacement.

## Decisions

### 1. Temporal cron workflow over setInterval/polling loop

Use Temporal's built-in cron schedule (`cronSchedule` option on `WorkflowClient.start`) for the pickup loop rather than a `setInterval` in the worker process.

**Rationale:** Temporal cron workflows survive worker restarts, are visible in the Temporal UI, and follow the project's existing pattern of using Temporal for all durable orchestration. A Node.js polling loop would be invisible, non-durable, and duplicate what Temporal already provides.

**Alternative considered:** A Temporal Schedule (the newer Temporal primitive). Equivalent outcome but cron workflows are simpler to set up and already well-supported in the SDK version we use.

### 2. `listItemsByStatus` on GitHubClient

Add a single new method `listItemsByStatus(status: StatusName): Promise<ProjectItemSummary[]>` that queries Projects v2 GraphQL for all items in a given status column.

**Rationale:** The pickup workflow only needs item IDs and basic metadata to start workflows. A focused query avoids over-fetching. This method also serves future features (dashboards, status reports).

`ProjectItemSummary` shape: `{ itemId: string; issueNumber: number; title: string; ticketId: string; createdAt: string }`. `ticketId` uses the same derivation as `getItem()` (`<owner>/<repo>#<issueNumber>`) so that workflow IDs produced by auto-pickup match those produced by the webhook bridge, ensuring dedup works across both intake paths. `createdAt` is the item creation timestamp used for deterministic ordering when `maxConcurrent` caps apply.

### 3. Derive `changeName` from issue via existing `slugify`

The `ticketWorkflow` requires a `changeName` slug. Add a `deriveChangeName(title: string, issueNumber: number): string` helper implemented in terms of the existing `slugify()` from `src/contracts/helpers.ts`. The result is `slugify(title) + "-" + issueNumber` when the slug is non-empty, or just `String(issueNumber)` when the title produces an empty slug (e.g., `"!!!"` → `"42"`).

**Rationale:** Manual `--change` naming is fine for CLI use, but auto-pickup must generate names without operator input. Reusing `slugify` avoids duplicating slug rules. Appending the issue number guarantees uniqueness across issues with identical titles.

### 4. Workflow ID as dedup key

Use `ticket-${ticketId}` as the workflow ID, where `ticketId` comes from `ProjectItemSummary.ticketId` (derived identically to `getItem().ticketId`). This matches the existing pattern in the webhook bridge. Temporal rejects `startWorkflow` with `WorkflowExecutionAlreadyStartedError` if a workflow with that ID is already running — this gives us free deduplication across both auto-pickup and webhook-triggered starts.

### 5. Dual intake: Backlog and Ready

The pickup scan queries both `Backlog` and `Ready` statuses. Items in each status map to different workflow entry points:

| Board status | `startPhase` | Workflow path |
|---|---|---|
| Backlog | `"specify"` (default) | Specify → Implement → Review |
| Ready | `"implement"` | Implement → Review (skip Specify) |

Add an optional `startPhase?: "specify" | "implement"` field to `TicketWorkflowInput`. When `startPhase` is `"implement"`, the workflow skips the Specify loop entirely and begins at the Implement phase. Default is `"specify"` for backward compatibility.

**Rationale:** Items in Ready have already had their spec reviewed. Running Specify on them would throw `SpecifyValidationError` because the phase rejects items in Ready status. The webhook bridge already handles the Ready → `specReviewed` signal path for *running* workflows, but auto-pickup must handle Ready items that have *no running workflow* (e.g., worker was down, item was moved manually).

**Prerequisite for implement-only pickup:** Items in Ready are assumed to have a spec bundle already on disk at `openspec/changes/<changeName>/`. If no such folder exists when the Implement phase starts, Implement will fail with its normal missing-spec error and the item will be transitioned to Blocked. This is the correct behavior — an item in Ready without a spec bundle indicates a manual board move that the operator must investigate. No special pre-check is added in the pickup layer.

### 6. Config section

```ts
pickup?: {
  enabled?: boolean;       // default: false
  intervalMinutes?: number; // default: 5, allowed: 1|2|3|4|5|6|10|12|15|20|30|60
  maxConcurrent?: number;  // default: 5, min: 1
}
```

The pickup cron workflow is only registered when `pickup.enabled` is `true`. The worker startup code conditionally starts it.

`intervalMinutes` is constrained to values that evenly divide 60 so that the Temporal cron expression (`*/<N> * * * *`) produces uniform intervals. Non-divisor values (e.g., 7) would cause uneven spacing; Zod validation rejects them.

`maxConcurrent` caps how many new workflows a single scan will start. When the board has more eligible items (Backlog + Ready combined) than the cap, the scan starts the oldest N (by `createdAt` timestamp from `ProjectItemSummary`) and defers the rest to the next interval. This prevents a burst of agent API calls when many tickets land at once.

## Risks / Trade-offs

- **[GraphQL rate limits]** → Each scan makes two paginated GraphQL calls (Backlog + Ready). At a 5-minute interval this is ~576 requests/day. Each Projects v2 query costs multiple GraphQL points depending on result size, but even worst-case (large boards, 10+ points per query) this stays well within GitHub's 5,000 points/hour limit.
- **[Stale item race]** → An item could be picked up and have its workflow started just as an operator manually starts it via CLI. Temporal's workflow-ID dedup prevents double-processing — the second start attempt is a no-op.
- **[Change name collisions]** → Two issues with identical titles would produce the same slug. Append the issue number to the slug (`<slug>-<issueNumber>`) to guarantee uniqueness.
- **[Burst of tickets]** → Many tickets landing in Backlog at once could overwhelm agent API rate limits and spike costs. `maxConcurrent` caps the number of workflows started per scan; remaining items are picked up in subsequent intervals.
