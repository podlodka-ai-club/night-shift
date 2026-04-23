## Context

The sprint goal is to ship a real, minimal orchestrator that takes a `Ready` GitHub Project item, derives execution artifacts with OpenSpec, implements against a detailed DoD, validates changes, and produces a pull request on a real repository. The implementation must stay intentionally small, but it also needs clean seams for later extensions from the feature factory vision.

The strongest constraints are:
- GitHub Project is the intake source and canonical run reference.
- OpenSpec artifacts are derived per-run artifacts, not a second backlog.
- TypeScript/Node is the required stack.
- Deterministic logic should be preferred over model decisions whenever possible.
- Run state, logs, token usage, and cost need to survive crashes and be inspectable after the run.

## Goals / Non-Goals

**Goals:**
- Build a single-process orchestrator with a durable, explicit state machine for one ticket run at a time.
- Keep persistence simple with disk-backed state and logs while hiding storage behind interfaces that can later move to SQLite or a service.
- Use provider adapters so `gpt-5-mini` via Codex SDK and Claude Sonnet 4.6 via Claude Agent SDK are replaceable implementation details.
- Make workflow progress visible through GitHub status transitions, blocked comments, and PR summaries/comments.
- Enforce agent-invocation budgets and track per-step and per-run token/cost totals.

**Non-Goals:**
- Multi-worker scheduling, distributed locking, or high-throughput queue processing.
- Automatic task decomposition, merge-conflict resolution, or long-term memory.
- Broad model-driven orchestration where the model decides workflow transitions, retries, or parsing.
- A custom web UI or database-backed observability system for the first sprint version.

## Decisions

### 1. Use a deterministic state machine inside a single Node worker

The orchestrator will be implemented as a single Node process that advances a ticket through named durable stages such as `claimed`, `specified`, `implemented`, `validated`, `pr_opened`, `reviewed`, `fixed`, `blocked`, and `completed`.

For the MVP, the external GitHub Project status model stays simpler than the internal state machine:
- `Ready`: the item is eligible for orchestration and has not been claimed.
- `In progress`: the item has been claimed and is moving through specification, implementation, or validation before a PR is ready for review.
- `In review`: the PR has been opened and the orchestrator is waiting on or executing the bounded review/fix loop.
- `Blocked`: the orchestrator cannot proceed without human action.

These values should be configurable, but the MVP should use the GitHub Project single-select field `Status` with these exact defaults so the workflow is easy to demo and reason about. The orchestrator does not move items to `Done` automatically in the MVP; completion after merge remains a human or team workflow step.

Why:
- This is the smallest design that still supports resume-after-crash.
- Workflow transitions, retries, and blocked handling remain programmatic and testable.

Alternatives considered:
- Temporal / workflow engine: stronger durability, but too much framework and operational overhead for the sprint.
- Fully stateless polling worker: less code initially, but poor recovery and weaker observability.

### 2. Keep GitHub Project canonical and generate OpenSpec per run

The selected GitHub Project item remains the source of truth for intake and external status. When a run starts, the orchestrator generates an OpenSpec change and artifacts as local execution assets tied to that ticket and run.

Why:
- It avoids a dual-backlog model where GitHub and OpenSpec can drift.
- It preserves the user request that specification be detailed and derived, not manually curated first.

Alternatives considered:
- Managing backlog state in OpenSpec: simpler locally, but breaks the requirement that GitHub Project drives intake.
- Asking the model to operate directly on the GitHub issue with no derived artifacts: cheaper, but weaker DoD discipline and worse auditability.

### 3. Isolate responsibilities behind thin adapters

The worker will be split into small modules such as `ProjectAdapter`, `RunStore`, `OpenSpecService`, `AgentRunner`, `RepoWorkspace`, `ValidationRunner`, and `ReportPublisher`. The state machine owns control flow; adapters own side effects.

Why:
- This keeps the implementation minimal while preserving clear extension points.
- It supports future provider swaps, additional stages, or alternate persistence without rewriting the whole worker.

Alternatives considered:
- A single large script: fastest to start, but fragile once review, budgets, and crash recovery are added.
- A plugin framework: more flexible, but unnecessary indirection for the first sprint version.

### 4. Persist run state and logs on disk in a run directory

Each run will store durable files under a run-specific directory, for example `./data/runs/<project-item-id>/`, including `state.json`, `events.jsonl`, `usage.json`, generated OpenSpec artifacts, and validation/review outputs.

Why:
- Disk persistence is the smallest way to satisfy crash recovery and observability requirements.
- Run folders make demos and debugging straightforward because all evidence for a ticket is co-located.

Alternatives considered:
- SQLite: a reasonable next step, but extra schema and migration work for the MVP.
- In-memory state only: insufficient for crash recovery.

### 5. Use programmatic git and validation steps, and create one PR per run

The orchestrator will create an isolated branch/worktree for the ticket, load deterministic validation commands from a checked-in root config file named `feature-factory.config.json`, and open a single PR for the run after initial validation passes. If that file is missing or does not define validation commands, the run is blocked with a clear comment instead of guessing from package scripts. Because a PR cannot receive comments before it exists, the initial PR body will backfill completed milestones, and subsequent stage transitions will be added as milestone comments.

Why:
- This honors the requirement to prefer programmatic control and gives the user a stable PR surface for progress.
- Opening one PR and updating it through review/fix cycles keeps the workflow easy to explain.

Alternatives considered:
- Opening the PR before validation: difficult to guarantee useful diffs and adds noisy failing PRs.
- Inferring validation commands from package scripts or repository contents: convenient, but too ambiguous for a deterministic MVP.
- Using only issue/project comments for status: simpler, but weaker PR-centric observability.

### 6. Bound every agent invocation with policy and accounting

Every agent invocation will be routed through a shared wrapper that attaches a budget, captures usage data where available, estimates cost via configured pricing, and blocks the run if the step or task budget is exceeded.

Why:
- Cost control is part of workflow correctness, not just reporting.
- A single wrapper keeps policy consistent across Codex SDK and Claude Agent SDK invocations.

The orchestrator delegates agent execution to the provider SDKs rather than implementing its own tool loop or harness:
- **Planning and review** use `@openai/codex-sdk` (`Codex` class → `startThread()` → `thread.run(prompt, { outputSchema })`). The SDK manages the Codex agent loop, tool execution, and context internally.
- **Implementation** uses `@anthropic-ai/claude-agent-sdk` (`query()` with `allowedTools` and `outputFormat`). The SDK manages the Claude agent loop and built-in tool execution.

### Hard requirement: structured output for all agent invocations

Every agent invocation MUST use the provider's structured output mechanism to guarantee machine-parseable JSON responses. Free-form text output is not acceptable — all agent responses must conform to a declared JSON schema enforced at the SDK level.

- **Codex SDK** (`outputSchema`): Passed as `TurnOptions.outputSchema` to `thread.run()`. The Codex agent is constrained to return JSON matching the schema. The `finalResponse` is valid JSON.
- **Claude Agent SDK** (`outputFormat`): Passed as `Options.outputFormat` with `{ type: 'json_schema', schema }` to `query()`. The Claude agent is constrained to return structured output matching the schema via `structured_output` in the result message.

This eliminates regex-based extraction, prevents prose leakage into artifacts, and makes all inter-stage data transfer type-safe. Specific schemas:
- **Specify stage**: `ARTIFACT_SCHEMA` — wraps markdown in `{ content: string }` to isolate artifact content from agent preamble/postamble.
- **Review stage**: `REVIEW_FINDINGS_SCHEMA` — returns `{ findings: ReviewFinding[] }` with severity, summary, file, line, actionable.
- **Implement stage**: `IMPLEMENT_RESULT_SCHEMA` — returns `{ summary, filesChanged, tasksCompleted }` for auditable implementation reports.
- **Fix stage**: `FIX_RESULT_SCHEMA` — returns `{ summary, fixesApplied: [{ finding, action, file? }] }` for traceable fix passes.

All schemas are defined centrally in `types.ts` and imported by both the `AgentRunner` and the stage modules.

The orchestrator's `AgentRunner` wrapper is responsible only for budget enforcement, usage recording, structured output schema injection, and thread lifecycle — not for implementing tool handling or agent inner loops.

Alternatives considered:
- Reporting costs only after the fact: too weak for a sprint prototype that explicitly promises budgets.
- Provider-specific accounting scattered through stage code: harder to maintain and test.

### 7. Keep review as a bounded, secondary stage

After the PR is opened, the orchestrator will invoke the Codex SDK (`gpt-5-mini`) to review the diff. The Codex agent autonomously analyzes the diff and returns structured review findings. The review adapter normalizes the response into a JSON array of findings with `severity`, `summary`, `file`, `line`, and `actionable`, while persisting the raw output for debugging. If the review returns actionable findings, the orchestrator may execute one bounded fix pass via the Claude Agent SDK, rerun validation, and update the same PR. If the review is empty or non-actionable, the run completes without another coding loop.

Why:
- This keeps the MVP predictable and cost-bounded.
- It still demonstrates an agentic review/fix workflow without turning the system into an open-ended loop.

Alternatives considered:
- Multiple automatic review/fix loops: attractive in theory, but too expensive and failure-prone for the first version.
- Parsing free-form review text directly in the state machine: less adapter work initially, but too brittle for deterministic automation.
- No secondary review: simpler, but misses one of the core differentiators of the proposal.

## Risks / Trade-offs

- [Disk-backed state is not robust for concurrent workers] -> Restrict the MVP to a single worker process and use a simple run lock file per ticket.
- [GitHub Project and issue/PR APIs have different surfaces] -> Keep GitHub interactions inside one adapter and treat project status updates and issue/PR comments as separate operations.
- [Provider token or cost data may be inconsistent] -> Use provider-reported usage when available and fall back to configured price tables and explicit `unknown` markers when it is not.
- [OpenSpec generation adds latency and cost even for clear tickets] -> Run specification once per ticket, persist artifacts, and do not regenerate unless the run is explicitly restarted from the specification stage.
- [PR milestone visibility cannot literally exist before PR creation] -> Backfill prior milestones in the initial PR body and continue with milestone comments after the PR is opened.

## Migration Plan

1. Implement the orchestrator against one GitHub Project and one target repository with local disk persistence.
2. Run on a small set of manually prepared `Ready` tasks to validate the end-to-end loop.
3. Stabilize blocked handling, budgeting, and PR summaries before adding optional extensions such as alternate strategies or more providers.
4. If persistence or concurrency pressure appears, replace the `RunStore` implementation with SQLite behind the same interface.

## Open Questions

- How should the checked-in `feature-factory.config.json` schema evolve after the MVP if later repos need optional setup hooks, environment declarations, or multiple validation profiles?
- Should a non-actionable but malformed Codex SDK review response block the run immediately, or should the MVP allow the run to complete while attaching the raw review output to the PR summary?