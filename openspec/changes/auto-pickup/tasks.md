## 1. GitHub Client — listItemsByStatus

- [x] 1.1 Add `ProjectItemSummary` type to `src/github/types.ts` (`itemId`, `issueNumber`, `title`, `ticketId`, `createdAt`)
- [x] 1.2 Add `listItemsByStatus(status: StatusName): Promise<ProjectItemSummary[]>` to `GitHubClient` interface
- [x] 1.3 Implement paginated GraphQL query in `src/github/projects.ts` (ordered by `createdAt` ascending)
- [x] 1.4 Add `listItemsByStatus` to `InMemoryFakeGitHubClient`
- [x] 1.5 Write tests: matching items with all fields, empty result, pagination, ordering by createdAt, fake support

## 2. Config — pickup section

- [x] 2.1 Extend `NightShiftConfigSchema` with optional `pickup` section (`enabled: boolean`, `intervalMinutes: number`, `maxConcurrent: number`)
- [x] 2.2 Add defaults (`enabled: false`, `intervalMinutes: 5`, `maxConcurrent: 5`); constrain `intervalMinutes` to divisors of 60 via Zod refinement; add Zod min(1) for `maxConcurrent`
- [x] 2.3 Write tests: valid config, missing section defaults, invalid interval rejected, non-divisor interval rejected (e.g., 7), invalid maxConcurrent rejected

## 3. Change name derivation

- [x] 3.1 Add `deriveChangeName(title: string, issueNumber: number): string` helper to `src/contracts/helpers.ts`, implemented using existing `slugify()`
- [x] 3.2 Write tests: mixed case, special characters, consecutive hyphens, number suffix, empty slug from all-special-char title

## 4. Pickup workflow + activities

- [x] 4.1 Create `src/orchestration/pickup-activities.ts` with `scanBoardActivity` that calls `listItemsByStatus` for both `"Backlog"` and `"Ready"`, merges results, and sorts by `createdAt` ascending
- [x] 4.2 Create `src/orchestration/pickup-workflow.ts` with `pickupWorkflow` that scans both statuses and starts `ticketWorkflow` per item (respecting `maxConcurrent` cap, passing `startPhase` based on status, using `ticketId` from `ProjectItemSummary` for workflow ID)
- [x] 4.3 Handle `WorkflowExecutionAlreadyStartedError` silently in the workflow
- [x] 4.4 Wire pickup activities into the worker when `config.pickup.enabled` is `true`
- [x] 4.5 Register the pickup cron workflow on worker startup with configured interval (cron expression `*/<N> * * * *`)
- [x] 4.6 Write tests: discovers Backlog items, discovers Ready items, correct startPhase per status, deduplicates, empty board, disabled by default, maxConcurrent across both statuses sorted by createdAt, webhook bridge and auto-pickup produce identical workflow IDs

## 5. Workflow startPhase support

- [x] 5.1 Add optional `startPhase?: "specify" | "implement"` to `TicketWorkflowInput`
- [x] 5.2 Update `ticketWorkflow` to skip Specify loop when `startPhase === "implement"`
- [x] 5.3 Add `"skipped"` rendering to dashboard for Specify phase (show as "⏭ Specify" in pipeline)
- [x] 5.4 Write tests: default starts at specify, startPhase implement skips specify, dashboard shows skipped, Ready item with missing spec bundle transitions to Blocked

## 6. Pickup CLI

- [x] 6.1 Create `src/cli/pickup.ts` with `night-shift pickup` command (scans Backlog + Ready, runs independently of `config.pickup.enabled`)
- [x] 6.2 Add `pickup` script to `package.json`
- [x] 6.3 Write tests: items found from both statuses, no items (exit 0), usage error (exit 64), unexpected error (exit 1)

## 7. Integration + boundaries

- [x] 7.1 Run full test suite + typecheck + lint:boundaries
- [x] 7.2 Update `night-shift.config.example.ts` with pickup section
