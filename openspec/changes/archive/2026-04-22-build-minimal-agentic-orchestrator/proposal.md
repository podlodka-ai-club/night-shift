## Why

The sprint needs a real end-to-end prototype that can pick up a ready task, implement it on a real repository, and deliver a pull request with minimal manual intervention. The current opportunity is to build the smallest orchestrator that proves this loop works while leaving clean extension points for the broader feature-factory ideas.

## What Changes

- Build a minimal TypeScript/Node orchestrator that treats a GitHub Project item in the `Ready` state as the intake source and source of truth for run state.
- Generate OpenSpec artifacts from the selected GitHub Project item using `gpt-5-mini` via the Codex SDK so specification and detailed DoD are derived run artifacts rather than a second backlog.
- Implement the task against the generated DoD using Claude Sonnet 4.6 via the Claude Agent SDK, run programmatic validation, and open a GitHub pull request for the result.
- Run an automated review pass with `gpt-5-mini` via the Codex SDK, apply fixes when review findings are actionable, and stop after a bounded number of review/fix cycles.
- Persist per-ticket workflow state and logs on disk so the orchestrator can resume after a crash instead of restarting the task.
- Track token usage, estimated cost, and per-invocation budgets for every agent step, and include cost and process summaries in the resulting pull request.
- Surface workflow progress through milestone comments and blocked comments so users can see the current stage without inspecting local logs.
- Prefer programmatic integrations, parsing, validation, and control flow over model-driven decisions wherever deterministic logic is possible.
- Enforce structured output (JSON schema) on every agent invocation — no agent response is accepted as raw text. Both Codex SDK (`outputSchema`) and Claude Agent SDK (`outputFormat`) structured output mechanisms are mandatory for all calls.

## Capabilities

### New Capabilities
- `github-project-run-lifecycle`: Claim ready GitHub Project tasks, persist run state on disk, update task status, and move blocked tasks to `Blocked` with an explanatory comment.
- `openspec-derived-task-execution`: Generate OpenSpec proposal/design/tasks artifacts from a project item, use the resulting DoD to drive implementation, and enforce per-step agent budgets.
- `review-and-pr-reporting`: Validate generated changes, run automated review/fix loops, publish milestone updates and summaries to the PR, and record workflow logs and cost data.

### Modified Capabilities
- None.

## Impact

- Adds a new TypeScript/Node orchestrator application with GitHub API integration and local disk-backed state/log storage.
- Introduces integrations with `gpt-5-mini` (via Codex SDK for planning and review) and Claude Sonnet 4.6 (via Claude Agent SDK for implementation) behind provider adapters.
- Requires a deterministic workflow/state machine, validation runner, PR publisher, and cost-tracking/reporting pipeline.
- Establishes the baseline architecture for future extensions described in the sprint vision, including richer routing, more agents, and stronger observability.