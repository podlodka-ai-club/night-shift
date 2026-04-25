## ADDED Requirements

### Requirement: Live dashboard rendering
The workflow SHALL call `setCurrentDetails()` with a Markdown string at every state transition to provide a real-time dashboard visible in the Temporal UI workflow overview page.

#### Scenario: Dashboard rendered on workflow start
- **WHEN** `ticketWorkflow` begins execution
- **THEN** `setCurrentDetails()` is called with Markdown containing the ticket ID, change name, and "Specify" as the current phase

#### Scenario: Dashboard updated on phase completion
- **WHEN** a phase activity (specify, implement, review) completes successfully
- **THEN** `setCurrentDetails()` is called with the completed phase shown in the timeline with its duration and result

#### Scenario: Dashboard updated on gate entry
- **WHEN** the workflow enters a blocked gate (e.g., `awaiting_spec_review`, `specify_needs_input`, `implement_needs_input`, `review_escalation`)
- **THEN** `setCurrentDetails()` is called with the blocked reason displayed in the status line

#### Scenario: Dashboard updated on gate exit
- **WHEN** the workflow receives a signal and exits a blocked gate
- **THEN** `setCurrentDetails()` is called with the blocked reason cleared and the next phase shown as active

### Requirement: Dashboard content
The dashboard Markdown SHALL include: a header with ticket ID and change name, the current phase indicator, the current status (running/blocked with reason), the review iteration counter, the cost rollup (USD and tokens), and a timeline table of completed phases with durations and results.

#### Scenario: Dashboard shows review iteration
- **WHEN** the workflow is in the review loop at iteration 1 of max 2
- **THEN** the dashboard contains "iteration 1/2"

#### Scenario: Dashboard shows cost rollup
- **WHEN** the workflow has accumulated cost data
- **THEN** the dashboard displays the total cost in USD and total tokens

#### Scenario: Dashboard shows phase timeline
- **WHEN** the specify phase completed in 134 seconds with result "refined"
- **THEN** the timeline table contains a row with "Specify", "2m 14s", and "refined"

### Requirement: renderDashboard is a pure function
The `renderDashboard()` helper SHALL be a pure function of the workflow state. It SHALL NOT perform I/O, call activities, or access non-deterministic APIs.

#### Scenario: Deterministic output
- **WHEN** `renderDashboard()` is called with identical state twice
- **THEN** it returns identical Markdown strings both times

### Requirement: Dashboard size limit
The rendered dashboard Markdown SHALL remain under 4 KiB to avoid impacting Temporal server performance.

#### Scenario: Maximum content scenario
- **WHEN** the workflow has completed all three phases with multiple review iterations and an active activity detail section with 10 log lines
- **THEN** the rendered Markdown is under 4096 bytes

### Requirement: Activity progress signal
Activities SHALL signal the workflow with a formatted Markdown string summarizing live agent events. The workflow SHALL define an `activityProgress` signal that accepts a single string argument.

#### Scenario: Activity sends progress signal during execution
- **WHEN** a phase activity (specify, implement, review) is running and an `AgentStreamEvent` of kind `tool-use` is received
- **THEN** the activity signals the workflow with a Markdown string containing the tool name and source

#### Scenario: Activity batches signals at 2-second intervals
- **WHEN** multiple `AgentStreamEvent`s arrive within 2 seconds
- **THEN** only one signal is sent containing all accumulated events

#### Scenario: Immediate signal on tool-use and turn-completed events
- **WHEN** an `AgentStreamEvent` of kind `tool-use` or `turn-completed` arrives and at least 2 seconds have passed since the last signal
- **THEN** a signal is sent immediately without waiting for the next batch interval

### Requirement: Activity progress dashboard section
The workflow SHALL store the latest activity progress Markdown in an `activityDetail` state variable. `renderDashboard()` SHALL render this section between the status header and the timeline table when non-empty.

#### Scenario: Dashboard shows live tool-use events
- **WHEN** the activity signals with Markdown containing a tool-use entry like `⚡ shell \`npm run typecheck\``
- **THEN** the dashboard rendered via `setCurrentDetails()` includes that tool-use line

#### Scenario: Activity detail cleared on phase completion
- **WHEN** a phase activity completes and the workflow transitions to the next phase
- **THEN** `activityDetail` is cleared and the dashboard no longer shows the previous phase's activity events

### Requirement: ActivityProgressReporter
A new `ActivityProgressReporter` class SHALL format `AgentStreamEvent`s into compact Markdown lines and signal the parent workflow at batched intervals.

#### Scenario: Tool-use event formatted
- **WHEN** `push()` is called with an `AgentStreamEvent` of kind `tool-use` with tool `npm run typecheck` and source `shell`
- **THEN** the formatted line contains `⚡ shell \`npm run typecheck\``

#### Scenario: Tool-result event formatted with duration
- **WHEN** `push()` is called with a `tool-result` event following a `tool-use` that started 2.1 seconds ago with status `completed`
- **THEN** the formatted line contains `→ ✅ (2.1s)`

#### Scenario: Message-completed event formatted with truncation
- **WHEN** `push()` is called with a `message-completed` event whose text exceeds 60 characters
- **THEN** the formatted line contains the first 60 characters followed by `...`

#### Scenario: Turn-completed event formatted with tokens and cost
- **WHEN** `push()` is called with a `turn-completed` event with usage of 1204 tokens and cost of 20000 microUSD
- **THEN** the formatted line contains `📊 Turn` and `1,204 tokens` and `$0.02`

#### Scenario: Rolling buffer capped at 10 entries
- **WHEN** more than 10 events are pushed
- **THEN** only the most recent 10 formatted lines are included in the signal payload

#### Scenario: Flush sends final signal
- **WHEN** `flush()` is called after the activity finishes
- **THEN** a final signal is sent with any remaining buffered events
