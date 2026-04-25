# Orchestration

Durable ticket workflow engine built on [Temporal](https://temporal.io/).

## Architecture

```
GitHub Webhook → webhook-bridge → Temporal Client
                                     ↓
                              ticketWorkflow
                              (workflow.ts)
                                ↓      ↑
                          activities.ts
                          (specify → implement → review)
                                ↓
                     Worker (worker.ts)
```

## Modules

| File | Purpose |
|---|---|
| `workflow.ts` | `ticketWorkflow` — orchestrates specify → implement → review with signal gates |
| `activities.ts` | Temporal activities wrapping phase runners |
| `worker.ts` | Worker startup and graceful shutdown |
| `webhook-bridge.ts` | Maps GitHub project board events to workflow starts/signals |
| `index.ts` | Barrel exports |

## CLI

```bash
# Start the Temporal worker
npm run worker

# Trigger a workflow for a project item
npm run start -- <projectItemId> --change <change-name>
```

## Configuration

Add to `night-shift.config.ts`:

```ts
temporal: {
  serverUrl: "localhost:7233",  // default
  namespace: "default",         // default
  taskQueue: "night-shift",     // default
}
```

## Signal Flow

| Board Status | Signal | Unblocks |
|---|---|---|
| Backlog (retry) | `specifyRetry` | `specify_needs_input` or `awaiting_spec_review` |
| Ready | `specReviewed` | `awaiting_spec_review` |
| Ready (retry) | `implementRetry` | `implement_needs_input` |
| In review | `resume` | `review_escalation` |

## Testing

```bash
# Run all orchestration tests
npx vitest run src/orchestration/

# Run workflow tests only
npx vitest run src/orchestration/__test__/workflow.test.ts
```

Tests mock the Temporal SDK entirely — no Temporal server needed.
