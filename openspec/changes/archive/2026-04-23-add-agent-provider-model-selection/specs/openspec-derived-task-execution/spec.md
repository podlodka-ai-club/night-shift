## MODIFIED Requirements

### Requirement: OpenSpec execution artifacts are derived from the project item
The orchestrator SHALL generate run-specific OpenSpec artifacts from the selected GitHub Project item and SHALL use those artifacts as the execution plan and detailed definition of done for the run. It SHALL resolve the configured `planner` role for the run and invoke the provider and model selected for that role when generating the specification artifacts.

#### Scenario: Specification artifacts are generated for a claimed item
- **WHEN** a claimed project item enters the specification stage
- **THEN** the orchestrator resolves the configured `planner` role to a supported provider and model
- **THEN** it invokes that provider through the corresponding supported SDK with structured output enforcement appropriate to the selected SDK
- **THEN** it writes proposal, design, specs, and tasks artifacts into the run's OpenSpec change directory
- **THEN** it records references to the generated artifacts and the actual provider/model used in the durable run data

### Requirement: Agent invocations are budgeted and metered
The orchestrator SHALL enforce a configured budget for every agent invocation and SHALL record token usage and estimated cost per step and per ticket using the provider and model resolved for the stage's configured role.

#### Scenario: Invocation completes within budget
- **WHEN** an agent invocation completes within its configured budget
- **THEN** the orchestrator records the configured role, provider, model, token usage, estimated cost, and elapsed time for that step
- **THEN** the response is parsed from the structured output contract supported by the selected SDK; raw text fallback is not permitted when a structured contract is required
- **THEN** it updates the aggregate usage totals for the ticket

#### Scenario: Invocation exceeds budget policy
- **WHEN** executing an agent step would exceed the configured invocation budget or total ticket budget
- **THEN** the orchestrator stops the step instead of advancing the workflow
- **THEN** it records budget exhaustion as the blocking reason for the run

### Requirement: Implementation is gated by deterministic validation
The orchestrator SHALL use the generated OpenSpec tasks and detailed definition of done to drive implementation via the configured `implementer` role through either supported SDK. Every implementer invocation MUST request structured output through the selected SDK's supported structured-output mechanism. The orchestrator MUST run deterministic validation commands loaded from a checked-in repository config file before opening a pull request.

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

## ADDED Requirements

### Requirement: Agent role selection is validated before execution
The orchestrator SHALL validate that every configured logical role references a supported provider and a model string, and SHALL require the credentials needed by the selected provider before it dispatches that role.

#### Scenario: Role uses a supported provider
- **WHEN** a role is configured with provider `codex` or `anthropic` and a model string
- **THEN** the orchestrator dispatches that role through the corresponding existing SDK
- **THEN** it passes the configured model through to the provider invocation without replacing it with a hard-coded default

#### Scenario: Role configuration is invalid
- **WHEN** a role is configured with an unsupported provider or missing provider credentials
- **THEN** the orchestrator blocks the run before executing that stage
- **THEN** the blocking reason identifies the role and configuration problem