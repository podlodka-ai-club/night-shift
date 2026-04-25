## ADDED Requirements

### Requirement: ticketWorkflow chains Specify → Implement → Review

The system SHALL expose a Temporal workflow function `ticketWorkflow(input: TicketWorkflowInput)` where `TicketWorkflowInput` carries at least `{ itemId: string, ticketId: string, profileId?: string }`. The workflow SHALL execute the specify activity, handle its outcome (refined → wait for either `specReviewed` to proceed or `specifyRetry` to re-run specify; needs_input → wait for `specifyRetry` then re-run specify), then execute the implement activity, handle its outcome (pr_opened → proceed to review; needs_input → wait for `implementRetry` then re-run implement), then enter the review loop. The workflow ID SHALL be `ticket-<ticketId>` so that starting the same ticket twice is rejected by Temporal as a duplicate. The entire ticket lifecycle SHALL be visible as a single workflow execution in the Temporal UI, with idle gaps during human gates.

#### Scenario: Happy path completes all three phases
- **GIVEN** a ticket in `Backlog` status
- **WHEN** `ticketWorkflow` runs, a human sends `specReviewed` after specify, and the reviewer approves
- **THEN** the specify, implement, and review activities are each invoked exactly once in that order
- **AND** the workflow completes successfully

#### Scenario: Workflow pauses after specify until spec is reviewed
- **GIVEN** `specifyActivity` has completed with `refined` and the item is in `Refined`
- **WHEN** no `specReviewed` signal has been sent
- **THEN** the workflow remains sleeping and `implementActivity` has NOT been invoked

#### Scenario: specReviewed signal unblocks implement
- **GIVEN** a workflow paused after specify with `refined` outcome
- **WHEN** a `specReviewed` signal is sent
- **THEN** the workflow proceeds to `implementActivity`

#### Scenario: Specify needs_input pauses until specifyRetry signal
- **GIVEN** `specifyActivity` has completed with `needs_input` and the item is in `Blocked`
- **WHEN** no `specifyRetry` signal has been sent
- **THEN** the workflow remains sleeping and `specifyActivity` has NOT been re-invoked

#### Scenario: specifyRetry signal re-runs specify
- **GIVEN** a workflow paused after specify `needs_input`
- **WHEN** a `specifyRetry` signal is sent
- **THEN** the workflow re-invokes `specifyActivity`

#### Scenario: Operator requests spec changes from Refined state
- **GIVEN** `specifyActivity` has completed with `refined` and the workflow is waiting for `specReviewed`
- **WHEN** the operator moves the item back to `Backlog` and a `specifyRetry` signal is sent
- **THEN** the workflow re-invokes `specifyActivity` (same as the needs_input retry path)

#### Scenario: Implement needs_input pauses until implementRetry signal
- **GIVEN** `implementActivity` has completed with `needs_input` and the item is in `Blocked`
- **WHEN** no `implementRetry` signal has been sent
- **THEN** the workflow remains sleeping and `implementActivity` has NOT been re-invoked

#### Scenario: implementRetry signal re-runs implement
- **GIVEN** a workflow paused after implement `needs_input`
- **WHEN** an `implementRetry` signal is sent
- **THEN** the workflow re-invokes `implementActivity`

#### Scenario: Duplicate ticket start is rejected
- **GIVEN** a workflow `ticket-T-42` is already running
- **WHEN** a second `ticketWorkflow` is started with `ticketId: "T-42"`
- **THEN** the Temporal client raises a duplicate-workflow error

### Requirement: Review loop retries on needs_fix up to max iterations

When the review activity returns verdict `needs-fix`, the workflow SHALL re-invoke the implement activity followed by the review activity. The loop SHALL run at most `maxIterations` times (default 2, matching `phase-contracts` escalation threshold). When `maxIterations` is exhausted without a `ready-to-merge` verdict, the workflow SHALL treat the result as an escalation.

#### Scenario: One fix iteration succeeds
- **GIVEN** the reviewer returns `needs-fix` on iteration 0 and `ready-to-merge` on iteration 1
- **WHEN** the workflow runs
- **THEN** the implement activity is invoked twice and the review activity is invoked twice
- **AND** the workflow completes with status `ready_to_merge`

#### Scenario: Max iterations exhausted triggers escalation
- **GIVEN** the reviewer returns `needs-fix` on every iteration
- **WHEN** the workflow runs with `maxIterations = 2`
- **THEN** after 2 review iterations the workflow enters the escalation path

### Requirement: Escalation pauses workflow until human signal

When the review verdict is `escalate` (or max iterations exhausted), the workflow SHALL wait for a `resume` signal using `workflow.condition()`. The workflow SHALL NOT poll or use timers to detect re-entry. Upon receiving the signal, the workflow SHALL re-enter the review loop at iteration 0.

#### Scenario: Signal resumes the workflow
- **GIVEN** a workflow paused after escalation
- **WHEN** a `resume` signal is sent to the workflow
- **THEN** the workflow re-enters the review loop starting at iteration 0

#### Scenario: No signal means workflow sleeps indefinitely
- **GIVEN** a workflow paused after escalation
- **WHEN** no signal is sent within 1 hour
- **THEN** the workflow remains sleeping and consumes no activity slots

### Requirement: Activities wrap existing phase runners

The system SHALL provide Temporal activities `specifyActivity`, `implementActivity`, and `reviewActivity`. Each activity SHALL build the real deps (GitHub client, agent adapter, filesystem, clock) from the loaded `NightShiftConfig`, invoke the corresponding phase runner (`runSpecifyPhase`, `runImplementPhase`, `runReviewPhase`), and return the phase's typed result. Activities SHALL NOT re-implement phase logic.

#### Scenario: specifyActivity returns a SpecBundle
- **WHEN** `specifyActivity` runs with a valid ticket
- **THEN** the returned value satisfies `SpecBundleSchema`

#### Scenario: implementActivity returns an ImplementationResult
- **WHEN** `implementActivity` runs with a valid ticket and spec bundle
- **THEN** the returned value satisfies `ImplementationResultSchema`

#### Scenario: reviewActivity returns a ReviewResult
- **WHEN** `reviewActivity` runs with a valid ticket, spec bundle, PR ref, and iteration
- **THEN** the returned value satisfies `ReviewResultSchema`

### Requirement: Activities classify errors as retryable or non-retryable

Transient failures (network errors, GitHub 5xx, agent provider timeouts) SHALL be thrown as regular errors so Temporal retries them. Phase validation errors (`code: "validation"`), escalation results, and usage errors SHALL be wrapped in Temporal `ApplicationFailure` with `nonRetryable: true` so the workflow can handle them without retry.

#### Scenario: Transient GitHub error is retried
- **GIVEN** the GitHub client throws a `GitHubTransientError` on the first call
- **WHEN** the activity is invoked by Temporal
- **THEN** Temporal retries the activity and it succeeds on the second attempt

#### Scenario: Validation error is not retried
- **GIVEN** the phase runner throws `ReviewPhaseError` with `code: "validation"`
- **WHEN** the activity wraps it as a non-retryable `ApplicationFailure`
- **THEN** Temporal does not retry and the workflow receives the failure immediately

### Requirement: Activity retry policy uses bounded exponential backoff

Activities SHALL be configured with an initial interval of 1 second, a backoff coefficient of 2, a maximum interval of 30 seconds, and a maximum of 5 attempts. The start-to-close timeout SHALL be 15 minutes (configurable via `NightShiftConfig`). Activities SHALL heartbeat every 30 seconds during long-running agent calls.

#### Scenario: Retry timing follows exponential backoff
- **GIVEN** an activity that fails transiently 3 times then succeeds
- **WHEN** Temporal retries
- **THEN** the delays approximate 1 s, 2 s, 4 s (with jitter)

#### Scenario: Start-to-close timeout cancels stuck activities
- **GIVEN** an activity that hangs indefinitely
- **WHEN** 15 minutes elapse without completion or heartbeat
- **THEN** Temporal cancels the activity with a timeout error

### Requirement: Worker process runs until interrupted

The system SHALL provide a `night-shift worker` CLI command that creates a Temporal worker connected to `config.temporal.serverUrl` (default `localhost:7233`), namespace `config.temporal.namespace` (default `default`), task queue `config.temporal.taskQueue` (default `night-shift`), registers the `ticketWorkflow` and all activities, and blocks until `SIGINT` or `SIGTERM`. On signal, the worker SHALL drain in-flight activities gracefully before exiting.

#### Scenario: Worker starts and connects
- **WHEN** `night-shift worker` is run with a reachable Temporal server
- **THEN** the process logs "Worker started" and begins polling the task queue

#### Scenario: SIGINT triggers graceful shutdown
- **GIVEN** a running worker with one in-flight activity
- **WHEN** `SIGINT` is sent
- **THEN** the worker stops accepting new tasks, waits for the in-flight activity to complete, and exits with code 0

### Requirement: Trigger CLI starts a workflow

The system SHALL provide a `night-shift start <projectItemId>` CLI command that loads config, creates a Temporal client, resolves the ticket from the project item, and starts `ticketWorkflow` with the resolved input. The command SHALL print the workflow run ID on success and exit with code 0. If the workflow is already running, it SHALL print the existing run ID and exit with code 0 (idempotent). On errors it SHALL exit with code 1.

#### Scenario: New workflow is started
- **WHEN** `night-shift start PVTI_abc` is run for a ticket not yet in-flight
- **THEN** a `ticketWorkflow` is started and the run ID is printed

#### Scenario: Duplicate start is idempotent
- **GIVEN** a workflow is already running for ticket `T-42`
- **WHEN** `night-shift start PVTI_abc` resolves to `T-42`
- **THEN** the existing run ID is printed and exit code is 0

### Requirement: Signal handlers use consumed-flag state to prevent buffered-signal leakage

For each workflow signal (`specifyRetry`, `specReviewed`, `implementRetry`, `resume`), the workflow SHALL maintain a boolean "requested" flag that the handler sets to `true`. Each human gate SHALL reset its corresponding flag to `false` upon entry, then `workflow.condition()` SHALL wait for the flag to become `true`, and the workflow SHALL clear the flag immediately after the condition unblocks. This pattern prevents Temporal's signal buffering from causing a stale signal received during one gate to spuriously unblock a later, unrelated gate.

#### Scenario: Stale signal does not unblock unrelated gate
- **GIVEN** a workflow paused at the specReviewed gate
- **WHEN** an `implementRetry` signal is received (e.g. from a buggy operator action) before any implement gate is entered
- **THEN** the specReviewed gate remains blocked
- **AND** when the workflow later enters the implementRetry gate, that gate also blocks (the stale flag was reset on entry)

#### Scenario: Rapid toggle is idempotent
- **GIVEN** a workflow paused at the specifyRetry gate
- **WHEN** two `specifyRetry` signals arrive in quick succession
- **THEN** specifyActivity is re-invoked exactly once
- **AND** the second signal does not affect any subsequent gate

### Requirement: Workflow tracks blockedReason for signal disambiguation

The workflow SHALL maintain an internal `blockedReason` field with type `"specify_needs_input" | "implement_needs_input" | "review_escalation" | "awaiting_spec_review" | null`. The value SHALL be set when the workflow enters a human gate and cleared when the corresponding signal is received. The workflow SHALL expose a Temporal query handler `getBlockedReason` that returns the current value. This field is workflow-internal state — it is NOT stored in GitHub. GitHub always shows a single `"Blocked"` status regardless of reason.

#### Scenario: blockedReason is set on specify needs_input
- **GIVEN** `specifyActivity` returns `needs_input`
- **WHEN** the workflow enters the specifyRetry wait
- **THEN** `getBlockedReason` returns `"specify_needs_input"`

#### Scenario: blockedReason is set on implement needs_input
- **GIVEN** `implementActivity` returns `needs_input`
- **WHEN** the workflow enters the implementRetry wait
- **THEN** `getBlockedReason` returns `"implement_needs_input"`

#### Scenario: blockedReason is set on review escalation
- **GIVEN** review verdict is `escalate`
- **WHEN** the workflow enters the resume wait
- **THEN** `getBlockedReason` returns `"review_escalation"`

#### Scenario: blockedReason is set on awaiting spec review
- **GIVEN** `specifyActivity` returns `refined`
- **WHEN** the workflow enters the specReviewed wait
- **THEN** `getBlockedReason` returns `"awaiting_spec_review"`

#### Scenario: blockedReason is cleared after signal
- **GIVEN** the workflow is waiting with `blockedReason === "specify_needs_input"`
- **WHEN** the `specifyRetry` signal is received
- **THEN** `getBlockedReason` returns `null`

### Requirement: Webhook bridge converts events to workflow starts or signals

The system SHALL export a `handleWorkflowTrigger(event: ParsedWebhookEvent, client: TemporalClient, config: NightShiftConfig)` function. The bridge SHALL query the workflow's `getBlockedReason` to disambiguate which signal to send when the same GitHub status transition could map to multiple signals. When the event is `project_v2_item.changed` with `currentStatus === "Backlog"`, the function SHALL start `ticketWorkflow` if no workflow exists for that ticket, or send the `specifyRetry` signal if one exists with `blockedReason === "specify_needs_input"` or `blockedReason === "awaiting_spec_review"` (operator rejected the spec from Refined). When the event transitions an item to `Ready`, the function SHALL query `getBlockedReason` and send `specReviewed` if `"awaiting_spec_review"`, or `implementRetry` if `"implement_needs_input"`. When the event transitions an item to `In review` and the workflow has `blockedReason === "review_escalation"`, the function SHALL send the `resume` signal. All other events SHALL be ignored.

#### Scenario: Backlog transition starts a workflow
- **GIVEN** a webhook event moving an item to `Backlog` with no existing workflow
- **WHEN** `handleWorkflowTrigger` processes it
- **THEN** `ticketWorkflow` is started for that item

#### Scenario: Backlog transition signals specify retry from blocked
- **GIVEN** a workflow paused with `blockedReason === "specify_needs_input"` for ticket `T-42`
- **WHEN** a webhook event moves `T-42` to `Backlog`
- **THEN** the `specifyRetry` signal is sent to workflow `ticket-T-42`

#### Scenario: Backlog transition signals specify retry from refined
- **GIVEN** a workflow paused with `blockedReason === "awaiting_spec_review"` for ticket `T-42`
- **WHEN** a webhook event moves `T-42` to `Backlog`
- **THEN** the `specifyRetry` signal is sent to workflow `ticket-T-42`

#### Scenario: Ready transition signals spec reviewed
- **GIVEN** a workflow paused after specify `refined` for ticket `T-42`
- **WHEN** a webhook event moves `T-42` to `Ready`
- **THEN** the `specReviewed` signal is sent to workflow `ticket-T-42`

#### Scenario: Ready transition signals implement retry
- **GIVEN** a workflow paused after implement `needs_input` for ticket `T-42`
- **WHEN** a webhook event moves `T-42` to `Ready`
- **THEN** the `implementRetry` signal is sent to workflow `ticket-T-42`

#### Scenario: In-review transition signals a paused workflow
- **GIVEN** a workflow paused after escalation for ticket `T-42`
- **WHEN** a webhook event moves `T-42` to `In review`
- **THEN** the `resume` signal is sent to workflow `ticket-T-42`

#### Scenario: Unrelated event is ignored
- **GIVEN** a webhook event for `issues.opened`
- **WHEN** `handleWorkflowTrigger` processes it
- **THEN** no workflow is started or signalled

#### Scenario: Status transition with no matching blockedReason is a no-op
- **GIVEN** a workflow with `blockedReason === null` (e.g. activity-driven status change)
- **WHEN** a webhook event reports a transition matching that workflow
- **THEN** no signal is sent (the bridge only signals when a gate is actively waiting)

### Requirement: Temporal config extends NightShiftConfigSchema

`NightShiftConfigSchema` SHALL be extended with an optional `temporal` sub-object: `{ serverUrl: string (default "localhost:7233"), namespace: string (default "default"), taskQueue: string (default "night-shift") }`. All fields SHALL have defaults so the section is optional for local development.

#### Scenario: Defaults are applied when temporal section is omitted
- **WHEN** a config omits the `temporal` key
- **THEN** the parsed config has `temporal.serverUrl === "localhost:7233"`, `temporal.namespace === "default"`, `temporal.taskQueue === "night-shift"`

#### Scenario: Custom values override defaults
- **WHEN** a config sets `temporal.namespace` to `"prod"`
- **THEN** the parsed config has `temporal.namespace === "prod"`

### Requirement: Workflow emits observability events

The workflow SHALL emit a `workflow.started` event (new type in the event contract) before the first activity and a `workflow.finished` event on every terminal path. The `workflow.finished` event SHALL include `ticketId`, `status` (`"completed" | "escalated" | "error"`), total `latencyMs`, and a `costRollup` summarising `totalMicroUsd` and `totalTokens` across all phase invocations. The workflow SHALL maintain a `costRollup` accumulator updated after every successful activity invocation; in the review loop, the accumulator SHALL sum across all implement and review iterations, not just the last one.

#### Scenario: workflow.started is emitted before first activity
- **WHEN** a workflow begins execution
- **THEN** exactly one `workflow.started` event is emitted before any `phase.started` event

#### Scenario: Completed workflow emits finish event with summed cost
- **WHEN** a workflow runs to `ready_to_merge` after one `needs-fix` iteration (specify + 2x implement + 2x review)
- **THEN** exactly one `workflow.finished` event with `status: "completed"` is emitted
- **AND** `costRollup.totalMicroUsd` equals the sum of costs across all five activity invocations
- **AND** `costRollup.totalTokens` equals the sum of tokens across all five activity invocations

#### Scenario: Escalated workflow emits finish event with accumulated cost
- **WHEN** a workflow exhausts max iterations and escalates without resume
- **THEN** a `workflow.finished` event with `status: "escalated"` is emitted
- **AND** `costRollup` reflects all activity invocations up to escalation

#### Scenario: Error workflow still emits workflow.finished
- **WHEN** a workflow fails with an unrecoverable error
- **THEN** a `workflow.finished` event with `status: "error"` is emitted

### Requirement: Workflow-level timeout prevents unbounded runs

The workflow SHALL have a configurable execution timeout (default 4 hours). When the timeout is reached, Temporal SHALL cancel the workflow. The cancellation SHALL emit a `workflow.finished` event with `status: "error"` and a timeout reason.

#### Scenario: Timeout cancels a stuck workflow
- **GIVEN** a workflow where an activity hangs indefinitely
- **WHEN** 4 hours elapse
- **THEN** Temporal cancels the workflow and a `workflow.finished` event with timeout reason is emitted

### Requirement: Module boundary for src/orchestration/

`src/orchestration/**` SHALL import from: `@temporalio/*`, `zod`, `node:*`, `src/contracts/**`, `src/config/**`, `src/github/**`, `src/adapters/**`, `src/phases/specify/**`, `src/phases/implement/**`, `src/phases/review/**`, and its own siblings. `src/orchestration/**` SHALL NOT import from `src/cli/**`, `src/git/**`, `src/worktree/**`, or `src/quality-gates/**`. Phase modules SHALL NOT import from `src/orchestration/**`.

#### Scenario: Boundary lint passes
- **WHEN** `npm run lint:boundaries` runs
- **THEN** `src/orchestration/**` produces no violations

#### Scenario: Phase importing orchestration is caught
- **GIVEN** a hypothetical `src/phases/specify/foo.ts` that imports from `src/orchestration/index.js`
- **WHEN** `npm run lint:boundaries` runs
- **THEN** the script exits non-zero and names the violation
