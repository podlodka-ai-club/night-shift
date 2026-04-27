# Design: SDK-based Structured Agent Sequences

## Status

Proposed

## Summary

Replace the current single-prompt `codex exec` activity with a generic Codex SDK runner that executes a configurable sequence of named steps in one thread. Each step provides a prompt and may optionally require structured output derived from a Zod schema. The runner stays generic and is not coupled to commit messages, pull requests, or any specific artifact type.

## Context

Today `runAgent` performs one unstructured edit prompt, while downstream activities still own metadata such as commit messages and pull request content. We want a configurable way to request structured values from the agent and reuse them in later operations without introducing tool or MCP complexity.

Codex SDK supports both multi-turn thread continuation and per-turn structured output schemas, which makes same-thread edit-plus-metadata sequences feasible.

## Goals

- Use Codex SDK instead of raw CLI execution.
- Support a configurable ordered sequence of agent steps.
- Allow any step to request structured output using a Zod-authored schema.
- Keep the step abstraction generic rather than tied to current GitHub use cases.
- Reuse the same thread across steps when possible.
- Make retries safe enough for Temporal activity re-execution.

## Non-goals

- Tool or MCP integration.
- Agent-controlled branch naming in v1.
- A fixed built-in list of supported artifact types.
- Designing a user-facing configuration language beyond what the orchestrator needs internally.

## Decision Summary

We will introduce a generic `runAgentSequence` activity flow built on the Codex SDK:

1. Start or resume a Codex thread.
2. Execute named steps in order.
3. For normal steps, send an unstructured prompt.
4. For structured steps, send a prompt plus JSON Schema generated from Zod.
5. Validate structured results again with Zod in the orchestrator.
6. Checkpoint progress after each successful step so retries can resume.

The same mechanism will support edit steps, metadata steps, and future structured artifact generation.

## Proposed Model

### 1. Agent sequence config

An agent run is defined as an ordered list of named steps. Each step is explicit and independently configurable.

Suggested fields:

- `id`: stable step identifier
- `prompt`: prompt text or prompt builder
- `resultKey?`: where to store the step result in the aggregated outputs map
- `schema?`: optional Zod schema for structured steps
- `required?`: whether failure should block the sequence
- `failurePolicy?`: how to react to invalid or missing structured output
- `settings?`: optional per-step overrides such as model or reasoning configuration

This keeps the abstraction centered on “run this step” rather than “generate this GitHub artifact.”

### 2. Sequence result

The runner should return a structured result that includes:

- `threadId`
- `completedStepIds`
- `outputs`: map of `resultKey -> parsed value`
- `finalResponse?`: optional last textual response for logging/debugging

The outputs map is intentionally generic so downstream code can consume only the keys it understands.

### 3. Structured output contract

For structured steps:

1. Author the schema in Zod.
2. Convert it to JSON Schema for the SDK turn.
3. Ask Codex for structured output using that schema.
4. Validate the returned value again with Zod.
5. Store the parsed result under `resultKey`.

The prompt describes how the agent should fill the schema, while the schema defines the contract the orchestrator relies on.

## Execution Flow

### Same-thread sequence

The preferred flow is one activity that runs multiple steps in the same Codex thread:

1. create worktree
2. start thread
3. run edit step
4. run structured metadata step in the same thread
5. return aggregated outputs

This preserves the best context for commit message and pull request generation because the model has direct memory of the edits it just made.

### Resume behavior

The activity must checkpoint enough state to resume after failure or retry:

- `threadId`
- completed step ids
- validated outputs collected so far

On retry, the activity resumes the existing thread and continues from the first incomplete step instead of replaying the whole sequence.

## Failure Handling

Failure policy should be defined per structured step, not globally.

Recommended default for structured steps:

1. run the step
2. validate output
3. if invalid, issue one repair prompt in the same thread
4. validate again
5. then either fail or fallback based on step policy

Useful policies:

- `fail`
- `repair_once_then_fail`
- `repair_once_then_fallback`
- `ignore_if_missing`

For v1, commit message and pull request details should likely use `repair_once_then_fallback`.

## Orchestrator Changes

### Activity layer

- Replace the current `runAgent` implementation with a sequence runner backed by Codex SDK.
- Extend the activity input to accept a step sequence configuration.
- Return aggregated outputs instead of `void`.

### Workflow layer

- Capture the agent result from `runAgent`.
- Pass relevant outputs into downstream activities.

### Downstream consumers

- `commitAndPush` should accept an optional agent-produced commit message.
- `openPullRequest` should accept optional agent-produced PR title/body.
- Deterministic fallbacks remain available when outputs are absent or invalid.

## V1 Scope

The first implementation should stay narrow even though the abstraction is generic.

Initial sequence:

1. edit repository contents
2. produce structured metadata for:
   - commit message
   - pull request title/body

Deferred for later:

- branch naming
- review comments
- tools/MCP
- user-defined reusable profiles

## Testing Strategy

- unit tests for sequence execution order
- unit tests for structured output validation and repair behavior
- unit tests for retry/resume using saved `threadId` and completed step state
- activity tests showing fallback behavior when structured output is missing or malformed
- workflow tests showing commit/PR consumers use agent outputs when present and deterministic defaults otherwise

## Open Questions

- Which Zod-to-JSON-Schema library should be used in this package?
- Should checkpoint state live only in Temporal heartbeats, or also in a file under the worktree for inspection?
- How much repo state should be added explicitly to the metadata prompt if same-thread context proves insufficient?

## Recommendation

Proceed with the SDK-based same-thread sequence design, keep the runner generic, and implement only the edit step plus one structured metadata step in v1.