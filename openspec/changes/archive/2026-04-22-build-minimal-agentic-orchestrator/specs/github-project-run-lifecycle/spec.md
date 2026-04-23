## ADDED Requirements

### Requirement: Orchestrator claims ready project items
The orchestrator SHALL treat configured GitHub Project items in the `Ready` state as the intake source and SHALL claim at most one active run per project item.

#### Scenario: Claim a ready project item
- **WHEN** the orchestrator polls the configured GitHub Project and finds an item in the `Ready` state with no active local run state
- **THEN** it creates a durable local run record for that item
- **THEN** it updates the project item to the configured in-progress state
- **THEN** it does not start a second active run for the same item while the first run remains active

### Requirement: Project status reflects the external workflow stage
The orchestrator SHALL drive a configurable GitHub Project workflow field whose MVP default values are `Ready`, `In progress`, `In review`, and `Blocked`.

#### Scenario: Item is under active implementation
- **WHEN** a claimed item is executing specification, implementation, or validation and no pull request has been opened yet
- **THEN** the project item status is `In progress`

#### Scenario: Item enters review
- **WHEN** the orchestrator opens the pull request and the review/fix loop becomes the active stage
- **THEN** the project item status is `In review`

### Requirement: Run state persists on disk
The orchestrator SHALL persist per-ticket execution state, stage history, and artifact references on disk so a restarted process can resume from the last durable stage.

#### Scenario: Resume after process restart
- **WHEN** the orchestrator starts and finds a persisted active run for a project item
- **THEN** it reloads the saved state and stage history from disk
- **THEN** it resumes from the last completed durable stage instead of recreating the run from the beginning

### Requirement: Blocked items are surfaced back to GitHub
The orchestrator SHALL move a blocked run's project item to `Blocked` and SHALL publish an explanatory comment when deterministic execution cannot continue.

#### Scenario: Run becomes blocked
- **WHEN** a stage cannot continue because of missing inputs, exhausted budget, provider failure, repository setup failure, or unrecoverable validation error
- **THEN** the orchestrator records the blocking reason and the failed stage in local state
- **THEN** it moves the project item to the configured `Blocked` state
- **THEN** it posts a comment that identifies the blocked stage, the reason, and the next action required to unblock the run

#### Scenario: Blocked item is re-queued by the user
- **WHEN** the orchestrator polls the project and finds an item in the `Ready` state that already has a local run record in the `blocked` stage
- **THEN** it derives the latest durable resume point from the recorded failed stage plus persisted local artifacts such as OpenSpec files, implementation outputs, validation results, and PR references
- **THEN** it treats a surviving local or remote branch as recoverable workspace and recreates the local worktree from that branch when the old worktree directory is missing
- **THEN** it preserves the existing branch, worktree, OpenSpec artifacts, and historical `events.jsonl` / `usage.json` whenever they are still usable for resume
- **THEN** it clears only the transient blocked metadata from local state before continuing
- **THEN** it restores the project item to the configured `In progress` or `In review` state based on the resumed internal stage
- **THEN** it continues from that durable stage instead of starting the run over from `claimed`