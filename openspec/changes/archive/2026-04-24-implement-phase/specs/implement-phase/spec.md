## ADDED Requirements

### Requirement: runImplementPhase entry point

The system SHALL expose `runImplementPhase(input, deps): Promise<ImplementResult>` where `input` matches the existing `ImplementInputSchema` (`{ ticket, specBundle }`) and `deps` injects every external effect (`github`, `agent`, `git`, `worktree`, `qualityGates`, `fs`, `clock`, `logger`, `config`). The function SHALL NOT perform any I/O outside of those deps. `ImplementResult` is a discriminated union of `{ status: "pr_opened", result: ImplementationResult }` and `{ status: "needs_input", openQuestions: string[], qualityGates: QualityGateResult[], blockingIssues: string[] }`.

#### Scenario: All I/O flows through deps
- **WHEN** the function runs with fake deps that record every call
- **THEN** `process.cwd`, `fetch`, `child_process`, and filesystem APIs outside `deps.fs`, `deps.worktree`, and `deps.qualityGates` are never invoked

#### Scenario: pr_opened result matches ImplementationResult contract
- **WHEN** the phase returns `{ status: "pr_opened", result }`
- **THEN** `ImplementationResultSchema.parse(result)` succeeds

### Requirement: Ticket context and spec bundle fetched via deps

The phase SHALL read the project item via `github.getItem(projectItemId)` (using the ticket id carried in `input`), fetch `github.listComments(issueNumber)` for the prompt context, and read each file listed in `input.specBundle` via `deps.fs`. When any spec-bundle file is missing on disk the phase SHALL throw `ImplementPhaseError` with `code: "io"` before any status transition.

#### Scenario: Missing spec file is surfaced as io error
- **GIVEN** `input.specBundle.specPath` points at a folder whose `proposal.md` does not exist
- **WHEN** the phase runs
- **THEN** an `ImplementPhaseError` with `code: "io"` is thrown
- **AND** no status transition, worktree, agent call, or gate run is emitted

#### Scenario: Comments are filtered of Night-Shift markers
- **GIVEN** an issue with a `specify:summary` marker comment and a reviewer reply
- **WHEN** the phase builds the implementer prompt
- **THEN** the user message contains the reviewer reply
- **AND** does not contain the `specify:summary` marker comment

### Requirement: Status transitions are idempotent and bounded

On entry the phase SHALL require `item.status ∈ { "Ready", "In progress" }`. Any other status SHALL cause an `ImplementPhaseError` with `code: "validation"` thrown before any mutation. On entry from `Ready` the phase SHALL transition to `In progress`; from `In progress` the phase MUST NOT emit a transition mutation. On a `pr_opened` outcome the phase SHALL transition to `In review`. On a `needs_input` outcome the phase SHALL transition to `Blocked`. Re-running a ticket after a terminal outcome is human-gated: the operator fixes the issue (or pushes commits), then moves the item back to `Ready`, and the orchestrator re-triggers the phase.

#### Scenario: Ready item is moved to In progress before agent call
- **GIVEN** an item whose current status is `Ready`
- **WHEN** the phase runs
- **THEN** `github.setStatus(itemId, "In progress")` is called before any `agent.run`

#### Scenario: Already-in-progress item skips the pre-transition
- **GIVEN** an item whose current status is `In progress`
- **WHEN** the phase runs
- **THEN** `github.setStatus(itemId, "In progress")` is NOT called

#### Scenario: Entry on Blocked is rejected
- **GIVEN** an item whose current status is `Blocked`
- **WHEN** the phase runs
- **THEN** `ImplementPhaseError` with `code: "validation"` is thrown; no `setStatus`, worktree, agent, or gate call is emitted

#### Scenario: In-review on success
- **WHEN** the phase completes with all gates passed, no blocking issues, and a PR opened
- **THEN** `github.setStatus(itemId, "In review")` is called exactly once at the end

#### Scenario: Blocked on needs_input
- **WHEN** the phase completes with any quality-gate failure or spec-review blocking issue after retry
- **THEN** `github.setStatus(itemId, "Blocked")` is called exactly once at the end
- **AND** no transition to `In review` is emitted

### Requirement: Worktree isolation

The phase SHALL create a worktree via `deps.worktree.create({ branch, ticketId })` before any file write, and SHALL remove it via `deps.worktree.remove(path)` on the successful `pr_opened` path. On any thrown error the worktree SHALL be left in place and its path SHALL be attached to the thrown error. All implementer writes, `git.writeTree` calls, and quality-gate commands SHALL run with the worktree path as cwd.

#### Scenario: Success removes the worktree
- **WHEN** the phase returns `pr_opened`
- **THEN** `deps.worktree.remove` is called exactly once with the path returned by `create`

#### Scenario: Failure keeps the worktree
- **WHEN** the phase throws any `ImplementPhaseError`
- **THEN** `deps.worktree.remove` is NOT called
- **AND** the thrown error's `worktreePath` field matches the path from `create`

### Requirement: Implementer response is a schema-validated JSON payload

The phase SHALL invoke the implementer agent with `TurnOpts.outputSchema = ImplementerResponseJsonSchema` (the JSON Schema projection of `ImplementerResponseSchema`). `finalText` SHALL be parsed as JSON and validated against `ImplementerResponseSchema` with shape `{ summary: string, filesWritten: Array<{ path: string; content: string }>, selfReportedRisks: string[] }`. `path` MUST reject absolute paths and parent traversal (`..`). A non-JSON `finalText` SHALL cause an `ImplementAgentError` with `code: "parse"`. A JSON payload that fails the schema SHALL cause an `ImplementAgentError` with `code: "schema"` and the phase SHALL retry the implementer exactly once with the Zod errors appended to the user message.

#### Scenario: Non-JSON response throws parse error
- **WHEN** the implementer returns the literal string `done`
- **THEN** an `ImplementAgentError` with `code: "parse"` is thrown and no files are written

#### Scenario: Schema-invalid JSON triggers one retry
- **WHEN** the implementer returns a JSON payload with `filesWritten[0].path = "/etc/passwd"`
- **THEN** `ImplementAgentError` with `code: "schema"` is raised and `agent.run` for the implementer role is called exactly twice total
- **AND** the second prompt contains the Zod error text

### Requirement: Spec-review subagent gates the diff

After files are written, the phase SHALL open a second adapter session with role `spec-reviewer` and pass the diff against the PR base plus the spec-bundle files. The response SHALL be parsed against `SpecReviewResponseSchema` (`{ subagentSummary: string, blockingIssues: string[] }`). Any non-empty `blockingIssues` SHALL trigger exactly one implementer retry with the issues appended to the next prompt. After that retry the phase SHALL proceed regardless; remaining blocking issues SHALL surface in the `needs_input` payload.

#### Scenario: Clean spec review proceeds to quality gates
- **WHEN** the spec-reviewer returns `blockingIssues: []`
- **THEN** `agent.run` for the implementer role is called exactly once and the phase moves on to `qualityGates.run`

#### Scenario: Blocking issues retry the implementer once
- **WHEN** the spec-reviewer returns `blockingIssues: ["missing error handling"]` on the first pass
- **THEN** the implementer is retried exactly once with that issue text in the prompt

#### Scenario: Unresolved blocking issues surface as needs_input
- **WHEN** blocking issues remain after the retry
- **THEN** the phase returns `status: "needs_input"` with `blockingIssues` populated

### Requirement: Quality gates run in the worktree

The phase SHALL execute each configured gate (`NightShiftConfig.qualityGates`) sequentially via `deps.qualityGates.run(gate, { cwd: worktreePath })`. Each `QualityGateResult` SHALL be collected. If any gate returns `status: "failed"`, the phase SHALL retry the implementer exactly once with the failed gate name and `logsTail` appended to the prompt; after that retry, all gates SHALL run again. If any gate still fails, the phase SHALL return `status: "needs_input"` with the failures listed as `openQuestions`.

#### Scenario: All gates pass on first try
- **WHEN** every configured gate returns `status: "passed"`
- **THEN** `qualityGates.run` is called once per gate and the phase proceeds to open a PR

#### Scenario: One failing gate triggers an implementer retry then re-runs all gates
- **WHEN** `typecheck` fails on the first pass
- **THEN** the implementer is retried exactly once and every gate is executed a second time

#### Scenario: Persistent failure surfaces as needs_input
- **WHEN** `typecheck` fails on both the first and second gate passes
- **THEN** the phase returns `status: "needs_input"` with the typecheck failure in `openQuestions`
- **AND** the item is transitioned to `Blocked`

### Requirement: Pull request is idempotent by branch

After writes and passing gates, the phase SHALL commit via `git.writeTree`, push via `github.pushBranch(branch, sha)`, and upsert a PR via `github.upsertPullRequest({ branch, baseBranch, title, body })`. Re-running the phase against the same branch SHALL update the existing PR rather than creating a duplicate. The resulting `PRRef` SHALL be included in the `ImplementationResult` returned.

#### Scenario: First run opens a PR
- **GIVEN** a branch with no existing PR
- **WHEN** the phase finishes
- **THEN** `upsertPullRequest` is called once and the returned `PRRef.number` is present in the result

#### Scenario: Retry updates the same PR
- **GIVEN** a branch that already has an open PR from a prior phase run
- **WHEN** the phase runs a second time
- **THEN** `upsertPullRequest` returns the same `number` and no new PR is created

### Requirement: Ticket comment is upserted with the implement:summary marker

The phase SHALL upsert a ticket comment via `github.upsertComment(issueNumber, "implement:summary", body)` on every terminal outcome (`pr_opened` or `needs_input`). The body SHALL include: the PR link, a table of `QualityGateResult` rows, the spec-review summary and blocking issues, the implementer's self-reported risks, and a footer with `latencyMs` and the adapter's reported usage. Repeated runs SHALL update the same comment rather than creating duplicates.

#### Scenario: First run creates a comment
- **WHEN** the phase finishes a first run
- **THEN** exactly one `upsertComment` call is made with markerId `implement:summary`

#### Scenario: needs_input still comments
- **WHEN** the phase ends in `needs_input`
- **THEN** the comment body lists the quality-gate failures and/or blocking issues verbatim

### Requirement: Error taxonomy

All errors thrown by the phase SHALL extend `ImplementPhaseError` and set a stable `code` field from the set `"validation" | "parse" | "schema" | "provider" | "git" | "gate" | "io"`. Errors SHALL carry the `ticketId` when known, the `worktreePath` when known, and the elapsed latency in ms.

#### Scenario: Every error is discoverable by instanceof
- **WHEN** any error thrown by the phase is caught
- **THEN** `err instanceof ImplementPhaseError` is true

#### Scenario: Codes are stable and enumerated
- **WHEN** each subclass is constructed
- **THEN** its `code` property matches the documented string

### Requirement: CLI wrapper

The system SHALL ship an executable `night-shift implement <projectItemId>` that loads `NightShiftConfig`, builds the real deps (GitHub client, Codex adapter for the `implementer` and `spec-reviewer` roles, simple-git, real worktree ops, real quality-gate runner), calls `runImplementPhase`, and exits with code `0` on `pr_opened`, `1` on `needs_input`, `2` on thrown errors, and `64` on usage errors.

#### Scenario: Exit code on pr_opened
- **WHEN** the phase resolves `status: "pr_opened"`
- **THEN** the process exits with code `0`

#### Scenario: Exit code on needs_input
- **WHEN** the phase resolves `status: "needs_input"`
- **THEN** the process exits with code `1`

#### Scenario: Exit code on thrown error
- **WHEN** the phase throws an `ImplementPhaseError`
- **THEN** the process exits with code `2` and the error message (plus `worktreePath` when known) is printed to stderr

### Requirement: Observability events

The phase SHALL emit a `phase.started` event before the worktree is created and a `phase.finished` event on every terminal path, using the `events` contract. The `phase.finished` event SHALL include `phase: "implement"`, `status` (`"pr_opened" | "needs_input" | "error"`), `ticketId`, `latencyMs`, the aggregated token/cost usage across all agent calls, and the PR number when one was opened.

#### Scenario: Started and finished are always paired on success
- **WHEN** a run completes with `pr_opened`
- **THEN** the logger received exactly one `phase.started` and one `phase.finished` with `status: "pr_opened"` and a populated `prNumber`

#### Scenario: Error path still emits phase.finished
- **WHEN** the phase throws after `phase.started` was emitted
- **THEN** a `phase.finished` event with `status: "error"` is emitted before the error propagates

### Requirement: Module boundaries for src/phases/implement, src/worktree, src/quality-gates

`src/phases/implement/**` SHALL import only from: `zod`, `node:*`, `src/contracts/**`, `src/adapters/**`, `src/github/**`, `src/git/**`, `src/worktree/**`, `src/quality-gates/**`, `src/config/**`, and its own siblings. `src/worktree/**` and `src/quality-gates/**` SHALL import only from `zod`, `node:*`, and `src/contracts/**`. Neither new module SHALL import from `src/cli/**`.

#### Scenario: Boundary lint passes on the shipped module
- **WHEN** `npm run lint:boundaries` runs
- **THEN** `src/phases/implement/**`, `src/worktree/**`, and `src/quality-gates/**` produce no violations

#### Scenario: A disallowed import is caught
- **GIVEN** a hypothetical `src/quality-gates/foo.ts` that imports from `src/github/index.js`
- **WHEN** `npm run lint:boundaries` runs
- **THEN** the script exits non-zero and names the violation
