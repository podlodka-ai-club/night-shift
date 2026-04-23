# review-and-pr-reporting Specification

## Purpose
TBD - created by archiving change build-minimal-agentic-orchestrator. Update Purpose after archive.
## Requirements
### Requirement: Pull requests expose workflow milestones
The orchestrator SHALL open a pull request for a validated run and SHALL expose completed and subsequent workflow stages through the pull request body and milestone comments.

#### Scenario: Initial PR publication backfills completed stages
- **WHEN** the orchestrator opens the first pull request for a run after validation succeeds
- **THEN** the pull request body includes the task summary, references to the generated OpenSpec artifacts, the completed stage milestones, and the current workflow status
- **THEN** later workflow transitions are appended to the same pull request as milestone comments

### Requirement: Secondary review can trigger one bounded fix pass
The orchestrator SHALL invoke the configured `reviewer` role to review the diff after opening the pull request and MAY execute one bounded fix pass when the review returns actionable findings. The review invocation MUST return structured findings through the selected SDK's structured-output mechanism. When a fix pass is required, the orchestrator MUST execute that fix pass through the configured `implementer` role and rerun deterministic validation before updating the existing pull request.

#### Scenario: Review returns actionable findings
- **WHEN** the configured `reviewer` role returns structured findings that map to concrete code changes
- **THEN** the orchestrator executes a single bounded fix pass through the configured `implementer` role against the existing branch
- **THEN** the fix pass returns a structured result with summary and applied fixes, not free-form text
- **THEN** it reruns deterministic validation before updating the existing pull request

#### Scenario: Review returns no actionable findings
- **WHEN** the configured `reviewer` role returns no actionable findings
- **THEN** the orchestrator marks the review stage complete without invoking another implementation step

### Requirement: Logs and cost summaries are retained and published
The orchestrator SHALL retain workflow logs on disk and SHALL publish aggregate usage, estimated cost, and outcome summary in the pull request. Usage records and retained logs SHALL identify the role, provider, and model actually used for planning, implementation, review, and any bounded fix pass.

#### Scenario: Run reaches a terminal reviewed state
- **WHEN** a run reaches a reviewed or completed terminal state
- **THEN** the orchestrator persists stage logs, review outputs, and usage data on disk, including the resolved role/provider/model for each invocation
- **THEN** the pull request summary includes aggregate token usage, estimated cost, and final workflow outcome

