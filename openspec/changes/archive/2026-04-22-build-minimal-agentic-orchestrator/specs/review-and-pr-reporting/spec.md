## ADDED Requirements

### Requirement: Pull requests expose workflow milestones
The orchestrator SHALL open a pull request for a validated run and SHALL expose completed and subsequent workflow stages through the pull request body and milestone comments.

#### Scenario: Initial PR publication backfills completed stages
- **WHEN** the orchestrator opens the first pull request for a run after validation succeeds
- **THEN** the pull request body includes the task summary, references to the generated OpenSpec artifacts, the completed stage milestones, and the current workflow status
- **THEN** later workflow transitions are appended to the same pull request as milestone comments

### Requirement: Secondary review can trigger one bounded fix pass
The orchestrator SHALL invoke `gpt-5-mini` via the Codex SDK to review the diff after opening the pull request and MAY execute one bounded fix pass when the review returns actionable findings. The review invocation MUST use a JSON `outputSchema` (`REVIEW_FINDINGS_SCHEMA`) so findings are returned as structured data — regex extraction of free-form text is not permitted. Fix pass invocations via the Claude Agent SDK MUST use `outputFormat` with `FIX_RESULT_SCHEMA`.

#### Scenario: Review returns actionable findings
- **WHEN** the Codex SDK review returns structured findings (via `REVIEW_FINDINGS_SCHEMA`) that map to concrete code changes
- **THEN** the orchestrator invokes a single fix pass via the Claude Agent SDK (with `FIX_RESULT_SCHEMA`) against the existing branch
- **THEN** the fix pass returns a structured result with summary and applied fixes — not free-form text
- **THEN** it reruns deterministic validation before updating the existing pull request

#### Scenario: Review returns no actionable findings
- **WHEN** the Codex SDK review returns no actionable findings
- **THEN** the orchestrator marks the review stage complete without invoking another implementation step

### Requirement: Logs and cost summaries are retained and published
The orchestrator SHALL retain workflow logs on disk and SHALL publish aggregate usage, estimated cost, and outcome summary in the pull request.

#### Scenario: Run reaches a terminal reviewed state
- **WHEN** a run reaches a reviewed or completed terminal state
- **THEN** the orchestrator persists stage logs, review outputs, and usage data on disk
- **THEN** the pull request summary includes aggregate token usage, estimated cost, and final workflow outcome