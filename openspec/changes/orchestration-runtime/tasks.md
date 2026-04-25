## 1. Setup and config

- [x] 1.1 Add `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity` to `package.json` dependencies
- [x] 1.2 Add `TemporalConfigSchema` to `src/config/schema.ts` (`serverUrl` default `"localhost:7233"`, `namespace` default `"default"`, `taskQueue` default `"night-shift"`); add `temporal: TemporalConfigSchema.optional()` to `NightShiftConfigSchema`
- [x] 1.3 Test: config without `temporal` key parses with defaults; custom values override defaults
- [x] 1.4 Add `src/orchestration/` entry to `scripts/check-boundaries.mjs` with allow-list: `@temporalio/*`, `zod`, `node:*`, `src/contracts/**`, `src/config/**`, `src/github/**`, `src/adapters/**`, `src/phases/specify/**`, `src/phases/implement/**`, `src/phases/review/**`; ensure phase modules exclude `src/orchestration/`
- [x] 1.5 Create `src/orchestration/` directory skeleton: `activities.ts`, `workflow.ts`, `worker.ts`, `webhook-bridge.ts`, `index.ts`

## 2. GitHub client: getItem

- [x] 2.1 Add `getItem(itemId: string): Promise<ProjectItem>` to `GitHubClient` interface in `src/github/client.ts`; define `ProjectItemSchema` in `src/github/types.ts` (`id`, `ticketId`, `status`, `title`, `issueNumber`)
- [x] 2.2 Implement `getItem` in `src/github/projects.ts` using Projects v2 GraphQL query to resolve item content and status field value
- [x] 2.3 Wire `getItem` through `src/github/factory.ts`
- [x] 2.4 Implement `getItem` on `InMemoryFakeGitHubClient` with `seedItem` helper
- [x] 2.5 Export `ProjectItem` type from `src/github/index.ts`
- [x] 2.6 Tests: known item returns correct data; unknown item throws `GitHubNotFoundError`; fake round-trips seeded item

## 3. Event contract extensions

- [x] 3.1 Add `workflow.started` and `workflow.finished` event types to the discriminator in `src/contracts/events.ts`; `workflow.finished` carries `ticketId`, `status` (`"completed" | "escalated" | "error"`), `latencyMs`, `costRollup: { totalMicroUsd, totalTokens }`
- [x] 3.2 Tests: event schemas accept the new types; discriminator narrows correctly

## 4. Activities

- [x] 4.1 Create `src/orchestration/activities.ts` with `specifyActivity(input)` that builds real deps from config, calls `runSpecifyPhase`, and returns `SpecBundle`
- [x] 4.2 Add `implementActivity(input)` that builds deps, calls `runImplementPhase`, and returns `ImplementationResult`
- [x] 4.3 Add `reviewActivity(input)` that builds deps, calls `runReviewPhase`, and returns `ReviewPhaseResult`
- [x] 4.4 Wrap phase validation errors and escalation results as Temporal `ApplicationFailure` with `nonRetryable: true`; let transient errors (network, 5xx) propagate for Temporal retry
- [x] 4.5 Add heartbeat calls (`Context.current().heartbeat()`) in each activity before invoking the phase runner
- [x] 4.6 Tests: specifyActivity returns valid SpecBundle with fake deps; implementActivity returns valid ImplementationResult; reviewActivity returns valid ReviewResult
- [x] 4.7 Tests: validation error is wrapped as non-retryable ApplicationFailure; transient error propagates as-is

## 5. Workflow

- [x] 5.1 Create `src/orchestration/workflow.ts` with `ticketWorkflow(input: TicketWorkflowInput)` that calls specifyActivity, branches on outcome (refined vs needs_input), then calls implementActivity, branches on outcome (pr_opened vs needs_input), then enters review loop
- [x] 5.2 Define signal handlers: `specifyRetry` (re-run specify after needs_input or operator-rejected refined), `specReviewed` (unblocks post-specify refined gate), `implementRetry` (re-run implement after needs_input), `resume` (unblocks escalation gate). Each handler SHALL set a corresponding boolean "requested" flag (e.g. `specifyRetryRequested`); each gate SHALL reset its flag to `false` on entry, wait via `workflow.condition()` for the flag to become `true`, and clear the flag immediately after unblocking
- [x] 5.3 Add `blockedReason` workflow state (`"specify_needs_input" | "implement_needs_input" | "review_escalation" | "awaiting_spec_review" | null`); set on entering each human gate, clear on signal received; expose via `getBlockedReason` Temporal query handler
- [x] 5.4 Implement specify loop: on `needs_input`, set `blockedReason = "specify_needs_input"`, enter `workflow.condition()` waiting for `specifyRetry` signal; on signal, clear reason, re-run specifyActivity; on `refined`, set `blockedReason = "awaiting_spec_review"`, wait for either `specReviewed` signal (proceed to implement) or `specifyRetry` signal (operator requests changes, re-run specify)
- [x] 5.5 Implement implement gate: on `needs_input`, set `blockedReason = "implement_needs_input"`, enter `workflow.condition()` waiting for `implementRetry` signal; on signal, clear reason, re-run implementActivity; on `pr_opened`, proceed to review loop
- [x] 5.6 Implement review loop: on `needs_fix` verdict, re-invoke implementActivity + reviewActivity; bounded by `maxIterations` (default 2)
- [x] 5.7 Implement escalation: on `escalate` verdict or max-iterations exhausted, set `blockedReason = "review_escalation"`, enter `workflow.condition()` waiting for `resume` signal; on signal, clear reason, re-enter review loop at iteration 0
- [x] 5.8 Configure activity options: retry policy (initial 1 s, backoff 2×, max interval 30 s, max 5 attempts), start-to-close timeout 15 min
- [x] 5.9 Set workflow execution timeout to 4 hours (configurable)
- [x] 5.10 Maintain `costRollup` accumulator (`{ totalMicroUsd: number, totalTokens: number }`) updated after every successful activity invocation; sum across all review-loop iterations
- [x] 5.11 Emit `workflow.started` event before first activity; emit `workflow.finished` on every terminal path (completed, escalated, error) with the accumulated `costRollup`
- [x] 5.12 Tests (workflow replay): happy path calls specify → waits for specReviewed → implement → review; returns completed
- [x] 5.13 Tests: specify needs_input → blockedReason = "specify_needs_input" → specifyRetry signal → cleared → re-runs specify
- [x] 5.14 Tests: specify refined → blockedReason = "awaiting_spec_review" → specifyRetry signal (operator rejects spec) → cleared → re-runs specify
- [x] 5.15 Tests: implement needs_input → blockedReason = "implement_needs_input" → implementRetry signal → cleared → re-runs implement
- [x] 5.16 Tests: needs_fix loops implement + review; max iterations triggers escalation path
- [x] 5.17 Tests: escalate → blockedReason = "review_escalation" → resume signal → cleared → re-enters review loop at iteration 0
- [x] 5.18 Tests: getBlockedReason query returns current blockedReason at each gate
- [x] 5.19 Tests: workflow.started emitted before first phase event; workflow.finished emitted on success, escalation, and error paths with accumulated costRollup
- [x] 5.20 Tests: costRollup sums across all review-loop iterations (specify + 2x implement + 2x review on a needs_fix scenario)
- [x] 5.21 Tests: stale buffered signal does not unblock unrelated gate (e.g. implementRetry received during specReviewed gate is ignored on entry to specReviewed and blocks the later implementRetry gate)
- [x] 5.22 Tests: rapid duplicate signals are idempotent (two specifyRetry signals re-run specify exactly once)

## 6. Worker

- [x] 6.1 Create `src/orchestration/worker.ts` exporting `startWorker(config: NightShiftConfig)` that creates a Temporal worker with the configured task queue, registers `ticketWorkflow` and all activities
- [x] 6.2 Handle `SIGINT`/`SIGTERM` for graceful shutdown: stop accepting new tasks, wait for in-flight activities, exit 0
- [x] 6.3 Create `src/cli/worker.ts` with `main(argv, env)`: load config, call `startWorker`, block until shutdown
- [x] 6.4 Tests: worker registers workflow and activities (mock Temporal Worker); graceful shutdown on SIGINT

## 7. Trigger CLI

- [x] 7.1 Create `src/cli/start.ts` with `main(argv, env)`: parse `<projectItemId>`, load config, create Temporal client, resolve ticket via `getItem`, start `ticketWorkflow`, print run ID
- [x] 7.2 Handle duplicate workflow (already running): print existing run ID, exit 0
- [x] 7.3 Exit codes: 0 success, 1 error, 64 usage
- [x] 7.4 Tests: happy path starts workflow and prints run ID; duplicate is idempotent; missing item ID prints usage and exits 64

## 8. Webhook bridge

- [x] 8.1 Create `src/orchestration/webhook-bridge.ts` exporting `handleWorkflowTrigger(event, temporalClient, config)`
- [x] 8.2 On `project_v2_item.changed` with `currentStatus === "Backlog"`: start `ticketWorkflow` if no workflow exists; query `getBlockedReason` and send `specifyRetry` signal if `"specify_needs_input"` or `"awaiting_spec_review"` (operator rejected spec from Refined)
- [x] 8.3 On transition to `Ready`: query `getBlockedReason` and send `specReviewed` if `"awaiting_spec_review"`, or `implementRetry` if `"implement_needs_input"`
- [x] 8.4 On transition to `In review`: query `getBlockedReason` and send `resume` signal if `"review_escalation"`
- [x] 8.5 Ignore all other events; if `getBlockedReason` returns `null` for a matched workflow, do not send a signal (status change was activity-driven, not operator-driven)
- [x] 8.6 Tests: Backlog event starts new workflow; Backlog event signals specifyRetry on blocked workflow; Backlog event signals specifyRetry on awaiting_spec_review workflow (operator rejects spec); Ready event signals specReviewed; Ready event signals implementRetry; In-review event signals resume; unrelated event is ignored; duplicate Backlog start is idempotent; transition matching a workflow with `blockedReason === null` is a no-op

## 9. Barrel exports and boundaries

- [x] 9.1 Create `src/orchestration/index.ts` with exports: `ticketWorkflow`, `startWorker`, `handleWorkflowTrigger`, activity functions, types
- [x] 9.2 Add `"worker": "tsx src/cli/worker.ts"` and `"start": "tsx src/cli/start.ts"` scripts to `package.json`
- [x] 9.3 Verify `npm run lint:boundaries` passes with the new module

## 10. Documentation

- [x] 10.1 Create `src/orchestration/README.md`: overview, architecture diagram, CLI usage, config, signal flow, test recipe
- [x] 10.2 Update root `README.md`: add orchestration module to modules list, add `worker` and `start` CLI commands, update scripts section
- [x] 10.3 Update `night-shift.config.example.ts` with `temporal` section

## 11. Validation

- [x] 11.1 `npm run typecheck` passes
- [x] 11.2 `npm test` passes (all existing + new tests)
- [x] 11.3 `npm run lint:boundaries` passes
- [x] 11.4 `openspec change validate orchestration-runtime --strict` passes
