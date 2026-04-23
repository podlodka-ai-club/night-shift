## 1. Runtime Skeleton

- [x] 1.1 Initialize the TypeScript/Node project entrypoint, configuration loader, and typed settings for GitHub, model providers, budgets, and repository paths.
- [x] 1.2 Define the durable workflow state model, stage enum, and run directory layout for `state.json`, `events.jsonl`, `usage.json`, generated artifacts, and command outputs.
- [x] 1.3 Implement the disk-backed `RunStore` with lock-file semantics and restart/resume loading for active tickets.

## 2. GitHub Project Lifecycle

- [x] 2.1 Implement a GitHub adapter that polls the configured Project for `Ready` items and claims one item by moving it to the configured in-progress state.
- [x] 2.2 Add blocked-run handling that moves the project item to `Blocked` and posts an explanatory comment to the linked issue or item.
- [x] 2.3 Wire the worker loop so it resumes persisted active runs before attempting to claim new work.

## 3. Derived OpenSpec and Agent Execution

- [x] 3.1 Implement an `OpenSpecService` that creates a per-run change and stores generated proposal, design, specs, and tasks artifacts under the run directory.
- [x] 3.2 Implement a shared `AgentRunner` wrapper for `gpt-5-mini` via Codex SDK and Claude Sonnet 4.6 via Claude Agent SDK with per-invocation budgets, usage capture, cost estimation, and mandatory structured output schemas (`outputSchema` for Codex, `outputFormat` for Claude). The wrapper delegates tool execution to the provider SDKs and does not reimplement agent inner loops.
- [x] 3.3 Build the specification stage that turns a claimed GitHub item plus repository context into OpenSpec artifacts using `gpt-5-mini` via the Codex SDK.

## 4. Repository Implementation and Validation

- [x] 4.1 Implement repository workspace management for a per-ticket branch/worktree and cleanup hooks.
- [x] 4.2 Build the implementation stage that invokes Claude Sonnet 4.6 via the Claude Agent SDK (with built-in tools: Read, Edit, Bash, Glob, Grep) against the generated OpenSpec tasks and records outputs and file changes in the run directory.
- [x] 4.3 Implement a deterministic `ValidationRunner` that executes configured commands, captures logs, and gates pull-request publication on success.

## 5. PR Publication, Review, and Reporting

- [x] 5.1 Implement PR publication that opens or updates a single PR, backfills completed milestones in the PR body, and appends milestone comments for later stages.
- [x] 5.2 Implement Codex SDK (`gpt-5-mini`) review parsing plus one bounded fix pass (via Claude Agent SDK) with revalidation before updating the existing PR branch.
- [x] 5.3 Publish aggregate token usage, estimated cost, and process summary to the PR while persisting workflow logs and review outputs on disk.

## 6. Testing Strategy and Coverage

- [x] 6.1 Define the MVP testing strategy in project docs: unit tests for pure orchestration logic, contract tests for adapters/parsers, and dry-run integration tests for the end-to-end workflow.
- [x] 6.2 Add unit tests for workflow state transitions, run locking/resume behavior, and budget accounting.
- [x] 6.3 Add unit or contract tests for config loading, validation command resolution from `feature-factory.config.json`, and Codex SDK review result normalization.
- [x] 6.4 Add GitHub adapter tests using fixtures or mocks for claiming `Ready` items, moving items through `In progress` and `In review`, and blocking with comments.
- [x] 6.5 Add dry-run integration tests or scripted scenarios covering the happy path from claim to PR, a blocked path caused by missing validation config, and crash recovery from persisted run state.

## 7. Hardening and Demo Readiness

- [x] 7.1 Add a single command or script that runs the automated test suite and dry-run checks used before demos.
- [x] 7.2 Add operator documentation covering configuration, required credentials (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), SDK dependencies (`@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`), run directory structure, test commands, and manual recovery procedures.