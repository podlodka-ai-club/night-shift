## ADDED Requirements

### Requirement: OpenSpec execution artifacts are derived from the project item
The orchestrator SHALL generate run-specific OpenSpec artifacts from the selected GitHub Project item and SHALL use those artifacts as the execution plan and detailed definition of done for the run.

#### Scenario: Specification artifacts are generated for a claimed item
- **WHEN** a claimed project item enters the specification stage
- **THEN** the orchestrator invokes `gpt-5-mini` via the Codex SDK with the project item content and relevant repository context
- **THEN** every Codex invocation uses a JSON `outputSchema` so the response is guaranteed valid structured JSON — free-form text responses are never accepted
- **THEN** it writes proposal, design, specs, and tasks artifacts into the run's OpenSpec change directory
- **THEN** it records references to the generated artifacts in the durable run state

### Requirement: Agent invocations are budgeted and metered
The orchestrator SHALL enforce a configured budget for every agent invocation and SHALL record token usage and estimated cost per step and per ticket.

#### Scenario: Invocation completes within budget
- **WHEN** an agent invocation completes within its configured budget
- **THEN** the orchestrator records the provider, model, token usage, estimated cost, and elapsed time for that step
- **THEN** the response is parsed from the structured output schema — raw text fallback is not permitted
- **THEN** it updates the aggregate usage totals for the ticket

#### Scenario: Invocation exceeds budget policy
- **WHEN** executing an agent step would exceed the configured invocation budget or total ticket budget
- **THEN** the orchestrator stops the step instead of advancing the workflow
- **THEN** it records budget exhaustion as the blocking reason for the run

### Requirement: Implementation is gated by deterministic validation
The orchestrator SHALL use the generated OpenSpec tasks and detailed definition of done to drive implementation via Claude Sonnet 4.6 through the Claude Agent SDK. Every Claude Agent SDK invocation MUST use `outputFormat` with a `json_schema` to return structured results. The orchestrator MUST run deterministic validation commands loaded from a checked-in repository config file before opening a pull request.

#### Scenario: Validation config is missing
- **WHEN** the orchestrator cannot find the required checked-in validation config file or the file does not define validation commands
- **THEN** it marks the run blocked instead of inferring commands heuristically
- **THEN** it records the missing or invalid config as the blocking reason

#### Scenario: Validation passes after implementation
- **WHEN** the implementation agent finishes code changes and every configured validation command exits successfully
- **THEN** the orchestrator records the successful validation results
- **THEN** it advances the run to pull request publication

#### Scenario: Validation fails after implementation
- **WHEN** any configured validation command fails after implementation
- **THEN** the orchestrator stores the validation output in the run logs on disk
- **THEN** it does not open a pull request until validation succeeds or the run is marked blocked