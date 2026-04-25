## ADDED Requirements

### Requirement: Pickup schedule workflow

The system SHALL provide a `pickupWorkflow` Temporal cron workflow that periodically scans the configured GitHub project board for items in `Backlog` and `Ready` statuses and starts a `ticketWorkflow` for each discovered item. Items in `Backlog` SHALL be started with `startPhase: "specify"` (the default). Items in `Ready` SHALL be started with `startPhase: "implement"` to skip the Specify phase. The cron interval SHALL be configurable via `config.pickup.intervalMinutes` (default: 5, constrained to divisors of 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60). The workflow SHALL only be registered when `config.pickup.enabled` is `true`.

#### Scenario: Discovers and starts workflows for Backlog items
- **WHEN** the pickup workflow runs and the board has 3 items in Backlog status
- **AND** `maxConcurrent` is 5 or higher
- **THEN** `ticketWorkflow` is started for each of the 3 items with `startPhase: "specify"`
- **AND** each workflow receives the correct `itemId`, `ticketId`, and `changeName`

#### Scenario: Discovers and starts workflows for Ready items
- **WHEN** the pickup workflow runs and the board has 2 items in Ready status with no running workflow
- **THEN** `ticketWorkflow` is started for each with `startPhase: "implement"`
- **AND** the workflows skip the Specify phase and begin at Implement

#### Scenario: Respects maxConcurrent cap across both statuses
- **WHEN** the pickup workflow runs and the board has 5 Backlog items and 5 Ready items
- **AND** `config.pickup.maxConcurrent` is 3
- **THEN** `ticketWorkflow` is started for only the 3 oldest items by `createdAt` timestamp (regardless of status)
- **AND** the remaining 7 items are left for the next scan interval

#### Scenario: Deduplicates against already-running workflows
- **WHEN** the pickup workflow discovers a Backlog item whose `ticketWorkflow` is already running
- **THEN** the duplicate start attempt is silently ignored (caught via `WorkflowExecutionAlreadyStartedError`)
- **AND** no error is raised

#### Scenario: Auto-pickup and webhook bridge produce identical workflow IDs
- **WHEN** the webhook bridge starts a workflow for item with `ticketId` `acme/widgets#42`
- **AND** the pickup workflow later discovers the same item
- **THEN** both use workflow ID `ticket-acme/widgets#42`
- **AND** the pickup start attempt is deduplicated via `WorkflowExecutionAlreadyStartedError`

#### Scenario: Empty board is a no-op
- **WHEN** the pickup workflow runs and the board has no items in Backlog or Ready status
- **THEN** the workflow completes without starting any child workflows

#### Scenario: Disabled by default
- **WHEN** the worker starts and `config.pickup` is absent or `config.pickup.enabled` is `false`
- **THEN** no pickup cron workflow is registered

### Requirement: Change name derivation from issue title

The pickup workflow SHALL derive `changeName` from the issue title using the existing `slugify()` helper from `src/contracts/helpers.ts`, then appending `-<issueNumber>` to guarantee uniqueness. When `slugify(title)` returns an empty string (e.g., title is all special characters), `changeName` SHALL be just `String(issueNumber)`.

#### Scenario: Title with mixed case and special characters
- **WHEN** an issue has title "Add User Authentication!" and number 42
- **THEN** the derived `changeName` is `add-user-authentication-42`

#### Scenario: Title with consecutive special characters
- **WHEN** an issue has title "fix: API -- rate limiting" and number 7
- **THEN** the derived `changeName` is `fix-api-rate-limiting-7`

#### Scenario: Title that produces an empty slug
- **WHEN** an issue has title "!!!" and number 99
- **THEN** the derived `changeName` is `99`

### Requirement: Workflow startPhase parameter

`TicketWorkflowInput` SHALL accept an optional `startPhase` field with values `"specify"` (default) or `"implement"`. When `startPhase` is `"implement"`, the workflow SHALL skip the entire Specify phase loop and begin directly at the Implement phase. The dashboard SHALL record the Specify phase as `"skipped"` (not pending or completed). All other workflow behavior (signals, review loop) SHALL be unaffected.

#### Scenario: Default starts at specify
- **WHEN** a `ticketWorkflow` is started without `startPhase`
- **THEN** the workflow begins at the Specify phase as before

#### Scenario: startPhase implement skips specify
- **WHEN** a `ticketWorkflow` is started with `startPhase: "implement"`
- **THEN** the workflow skips the Specify phase entirely
- **AND** begins at the Implement phase
- **AND** the dashboard shows Specify as "⏭ Specify" (skipped)

#### Scenario: Ready item with missing spec bundle transitions to Blocked
- **WHEN** a `ticketWorkflow` is started with `startPhase: "implement"` for a Ready item
- **AND** no spec bundle exists at `openspec/changes/<changeName>/`
- **THEN** the Implement phase fails with its normal missing-spec error
- **AND** the item is transitioned to Blocked

### Requirement: Pickup CLI command

The system SHALL provide a `night-shift pickup` CLI command that runs the board scan once and reports which workflows were started. This command SHALL NOT require a running Temporal worker — it connects as a Temporal client and starts workflows directly. The command runs independently of `config.pickup.enabled` (the config flag controls only the cron workflow, not the CLI).

#### Scenario: Manual pickup run
- **WHEN** the operator runs `night-shift pickup`
- **THEN** the system scans the board for Backlog and Ready items, starts workflows, and prints a summary of started/skipped items

#### Scenario: No items to pick up
- **WHEN** the operator runs `night-shift pickup` and the board has no Backlog or Ready items
- **THEN** the system prints "No items to pick up" and exits with code 0

#### Scenario: Usage error
- **WHEN** the operator runs `night-shift pickup` with invalid arguments
- **THEN** the system prints usage information and exits with code 64

#### Scenario: Unexpected error
- **WHEN** the pickup scan encounters an unexpected error (e.g., GitHub API failure)
- **THEN** the system prints the error message to stderr and exits with code 1

### Requirement: Pickup configuration

The `NightShiftConfigSchema` SHALL accept an optional `pickup` section with `enabled` (boolean, default `false`), `intervalMinutes` (number, default 5, must be a divisor of 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60), and `maxConcurrent` (number, default 5, minimum 1). Invalid values SHALL be rejected by Zod validation.

#### Scenario: Valid pickup config
- **WHEN** config includes `pickup: { enabled: true, intervalMinutes: 10, maxConcurrent: 3 }`
- **THEN** the config loads successfully with the provided values

#### Scenario: Defaults applied when section is partial
- **WHEN** config includes `pickup: { enabled: true }`
- **THEN** `intervalMinutes` defaults to 5 and `maxConcurrent` defaults to 5

#### Scenario: Invalid interval rejected
- **WHEN** config includes `pickup: { enabled: true, intervalMinutes: 0 }`
- **THEN** Zod validation fails with an error about minimum interval

#### Scenario: Non-divisor interval rejected
- **WHEN** config includes `pickup: { enabled: true, intervalMinutes: 7 }`
- **THEN** Zod validation fails with an error that the value must be a divisor of 60

#### Scenario: Invalid maxConcurrent rejected
- **WHEN** config includes `pickup: { enabled: true, maxConcurrent: 0 }`
- **THEN** Zod validation fails with an error about minimum value
