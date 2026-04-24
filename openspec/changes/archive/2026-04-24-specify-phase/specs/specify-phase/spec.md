## ADDED Requirements

### Requirement: runSpecifyPhase entry point

The system SHALL expose `runSpecifyPhase(input, deps): Promise<SpecifyResult>` where `input` has a single `projectItemId: string` field and `deps` injects every external effect (`github`, `agent`, `git`, `fs`, `openspecCli`, `clock`, `logger`). The function SHALL NOT perform any I/O outside of those deps. `SpecifyResult` is a discriminated union of `{ status: "refined", bundle: SpecBundle }` and `{ status: "needs_input", openQuestions: string[], assumptions: string[], risks: string[] }`.

#### Scenario: All I/O flows through deps
- **WHEN** the function runs with fake deps that record every call
- **THEN** `process.cwd`, `fetch`, `child_process`, and filesystem APIs outside `deps.fs` are never invoked

#### Scenario: Refined result matches SpecBundle contract
- **WHEN** the phase returns `{ status: "refined", bundle }`
- **THEN** `validateSpecBundle(ticket, bundle)` returns `{ ok: true }`

### Requirement: Ticket fetched via GitHubClient

The phase SHALL fetch the project item via `github.getItem(projectItemId)`, the linked issue via `github.getIssue(issueNumber)`, and the full comment history via `github.listComments(issueNumber)`. When the project item has no `issueNumber`, the phase SHALL throw `SpecifyItemMissingError` and MUST NOT write any files or transition status.

#### Scenario: Happy path builds a Ticket
- **GIVEN** a project item linked to issue #42 in repo `acme/widgets`
- **WHEN** `runSpecifyPhase({ projectItemId: "PVTI_1" }, deps)` is called
- **THEN** `deps.github.getItem("PVTI_1")` is called, then `deps.github.getIssue(42)`, then `deps.github.listComments(42)`, in that order
- **AND** the resulting `Ticket.sourceRef` points at issue 42

#### Scenario: Item without a linked issue is rejected
- **GIVEN** a project item whose `issueNumber` is undefined
- **WHEN** the phase runs
- **THEN** a `SpecifyItemMissingError` is thrown before any status transition or file write

### Requirement: Status transitions are idempotent and bounded

Before the specifier call, the phase SHALL transition the project item from `Backlog` to `Refinement`; if the item is already in `Refinement` the phase MUST NOT emit a transition mutation (crash-recovery idempotency within a single run). On a `refined` outcome the phase SHALL transition to `Refined`. On a `needs_input` outcome the phase SHALL transition to `Blocked`. The phase SHALL NOT accept items whose current status is `Blocked`, `Refined`, `Ready`, `In progress`, `In review`, or `Ready to merge` — a typed `SpecifyPhaseError` with `code: "validation"` SHALL be thrown before any mutation. Re-running a ticket after a terminal outcome is a human-gated operation in both directions: the operator moves a `Blocked` item back to `Backlog` to supply answers, and a reviewer moves a `Refined` item back to `Backlog` to request revisions. In either case the orchestrator picks the ticket up on its next tick and the normal `Backlog → Refinement` path fires with the updated comment history included.

#### Scenario: Backlog item is moved to Refinement before LLM call
- **GIVEN** an item whose current status is `Backlog`
- **WHEN** the phase runs
- **THEN** `github.setStatus(itemId, "Refinement")` is called before `agent.run(...)`

#### Scenario: Already-in-Refinement item is not re-transitioned
- **GIVEN** an item whose current status is `Refinement`
- **WHEN** the phase runs
- **THEN** `github.setStatus(itemId, "Refinement")` is NOT called

#### Scenario: Refined on success
- **WHEN** the phase completes with zero open questions and a valid bundle
- **THEN** `github.setStatus(itemId, "Refined")` is called exactly once at the end

#### Scenario: Blocked on needs_input
- **WHEN** the phase completes with at least one open question or exhausted validator retries
- **THEN** `github.setStatus(itemId, "Blocked")` is called exactly once at the end
- **AND** no transition to `Refined` is emitted

#### Scenario: Blocked entry is rejected (operator must reset to Backlog)
- **GIVEN** an item whose current status is `Blocked`
- **WHEN** the phase is invoked on it
- **THEN** a typed `SpecifyPhaseError` with `code: "validation"` is thrown; no `setStatus`, `createBranch`, `agent.run`, or file write is emitted

#### Scenario: Operator unblocks via Backlog reset
- **GIVEN** an item previously left in `Blocked` whose issue now has a new operator comment answering the open questions
- **WHEN** the operator moves the item to `Backlog` and the orchestrator re-triggers the phase
- **THEN** the normal `Backlog → Refinement` pre-transition is emitted
- **AND** `github.listComments` returns the new operator comment to the specifier prompt

#### Scenario: Reviewer requests revision via Backlog reset
- **GIVEN** an item previously left in `Refined` whose issue now has a new reviewer comment requesting changes
- **WHEN** the reviewer moves the item to `Backlog` and the orchestrator re-triggers the phase
- **THEN** the normal `Backlog → Refinement` pre-transition is emitted
- **AND** the new reviewer comment is rendered in the user message passed to `agent.run`
- **AND** the existing change folder on the ticket branch is read and included in the prompt as a revision base

#### Scenario: Terminal statuses are never overwritten
- **GIVEN** an item whose status is `Ready`
- **WHEN** the phase runs
- **THEN** a typed `SpecifyPhaseError` is thrown; no `setStatus` is emitted

### Requirement: Ticket comments are part of the specifier prompt

The user message passed to the specifier SHALL include every non-Night-Shift comment from `github.listComments(issueNumber)` rendered in chronological order, so that human replies posted after a previous terminal outcome (operator answers after `Blocked`, or reviewer feedback after `Refined`) are visible to the specifier on the next attempt. Comments whose body starts with the Night Shift marker prefix `<!-- night-shift:marker=` SHALL be filtered out to avoid feeding the previous run's summary back into the prompt.

#### Scenario: First run with no comments
- **GIVEN** an issue with zero comments
- **WHEN** the phase runs
- **THEN** `listComments` is called and the rendered user message contains no comment block

#### Scenario: Operator answers are visible on re-run
- **GIVEN** an issue with one Night-Shift marker comment and one operator reply authored afterwards
- **WHEN** the phase runs
- **THEN** the user message passed to `agent.run` contains the operator reply verbatim
- **AND** does not contain the Night-Shift marker comment

#### Scenario: Reviewer feedback is visible on revision
- **GIVEN** an issue with a Night-Shift `specify:summary` marker comment (from a prior `Refined` run) and a later reviewer comment requesting changes
- **WHEN** the phase runs after the reviewer moved the item to `Backlog`
- **THEN** the user message contains the reviewer comment
- **AND** does not contain the `specify:summary` marker comment

### Requirement: Existing change folder seeds a revision

When `openspec/changes/<name>/` already exists on the ticket branch at phase start (e.g. after a reviewer moved a `Refined` ticket back to `Backlog`), the phase SHALL read each file in the folder via `deps.fs` and include its contents in the specifier prompt under a `## Current draft` section, instructing the specifier to revise the draft rather than rewrite from scratch. When the folder does not exist the phase SHALL proceed without a `## Current draft` section. The specifier's returned `files[]` SHALL overwrite the existing files wholesale — the phase does no three-way merge.

#### Scenario: First run has no prior draft
- **GIVEN** a ticket branch on which the change folder does not exist
- **WHEN** the phase runs
- **THEN** the user message passed to `agent.run` contains no `## Current draft` section

#### Scenario: Revision run seeds the prompt with the prior draft
- **GIVEN** a ticket branch on which `openspec/changes/<name>/proposal.md` and `openspec/changes/<name>/tasks.md` already exist from a prior `Refined` run
- **WHEN** the phase runs after the reviewer moved the item back to `Backlog`
- **THEN** the user message contains a `## Current draft` section with the contents of both files

#### Scenario: Revised files overwrite the prior draft
- **GIVEN** a revision run where the specifier returns new content for `proposal.md`
- **WHEN** the phase writes the returned `files[]`
- **THEN** `proposal.md` on the resulting commit matches the specifier's new content (not the prior content)

### Requirement: Branch is created before writing files

The phase SHALL call `github.createBranch(branchNameFor(ticket))` before any file is written. The call SHALL be idempotent (tolerates a branch that already points at the expected sha) per the `github-integration` contract.

#### Scenario: Branch created from default branch on first run
- **WHEN** the phase runs against a repo where the branch does not yet exist
- **THEN** `github.createBranch("night-shift/<id>-<slug>")` is called exactly once and returns the target ref

#### Scenario: Retry after branch exists does not throw
- **GIVEN** a previous phase run already created the branch
- **WHEN** the phase runs again with the same inputs
- **THEN** `createBranch` returns successfully and the phase continues

### Requirement: Specifier response is a schema-validated JSON payload

The phase SHALL request structured output from the agent adapter by passing `TurnOpts.outputSchema = SpecifierResponseSchema` (JSON Schema projection). The adapter's `finalText` SHALL be parsed as JSON and validated against `SpecifierResponseSchema` with shape `{ files: Array<{ path: string; content: string }>, openQuestions: string[], assumptions: string[], risks: string[] }`. `path` MUST match `^(proposal|design|tasks|specs/[a-z0-9-]+/spec)\.md$` and at minimum `proposal.md` and `tasks.md` MUST be present. A non-JSON `finalText` SHALL cause a `SpecifyAgentError` with `code: "parse"`. A JSON payload that fails the schema SHALL cause a `SpecifyAgentError` with `code: "schema"`.

#### Scenario: outputSchema is forwarded to the adapter
- **WHEN** the phase calls the agent
- **THEN** the `TurnOpts` passed to `session.run` has `outputSchema` set to the JSON Schema projection of `SpecifierResponseSchema`

#### Scenario: Well-formed JSON parses into files + meta
- **WHEN** the agent returns a JSON payload with `files` covering `proposal.md`, `design.md`, `specs/<cap>/spec.md`, `tasks.md` and populated meta fields
- **THEN** the phase stages those four files and attaches the meta fields to the result

#### Scenario: Non-JSON response throws parse error
- **WHEN** `finalText` is the literal string `sorry, I can’t do that`
- **THEN** a `SpecifyAgentError` with `code: "parse"` is thrown and no files are written

#### Scenario: Schema-invalid JSON triggers retry
- **WHEN** the agent returns a JSON payload whose `files[0].path` is `proposal.txt`
- **THEN** a `SpecifyAgentError` with `code: "schema"` is raised and the phase retries the agent once with the Zod errors appended to the user message

#### Scenario: Path escape is rejected by the schema
- **WHEN** the agent returns a JSON payload whose `files[0].path` is `../../etc/passwd`
- **THEN** the schema rejects it with `code: "schema"` and nothing is written

#### Scenario: Missing required file is rejected by the schema
- **WHEN** the agent returns a payload with only `design.md` and `specs/.../spec.md`
- **THEN** the schema refinement rejects the payload and the phase retries the agent once

### Requirement: Written change folder validates with openspec CLI

After writing the files and committing them on the ticket branch via `git.writeTree`, the phase SHALL invoke `openspecCli.validate(changeName, { strict: true })`. On a non-zero exit, the phase SHALL delete the change folder, retry the specifier exactly once, and then: if the retry also fails, return `{ status: "needs_input", openQuestions: [validatorError, ...] }`.

#### Scenario: Valid output on first try
- **WHEN** the specifier returns a spec that validates strict
- **THEN** `openspecCli.validate` is called once, returns success, and the phase proceeds to transition status

#### Scenario: One retry on validation failure
- **WHEN** the specifier's first response fails strict validation
- **THEN** the change folder is removed, `agent.run(...)` is called exactly twice total, and the retry's validator result determines the final outcome

#### Scenario: Two failures surface as open questions
- **WHEN** both specifier attempts fail validation
- **THEN** the phase returns `status: "needs_input"` with validator errors included in `openQuestions`
- **AND** the item is transitioned to `Blocked`

### Requirement: Ticket comment is upserted with the specify:summary marker

The phase SHALL upsert a ticket comment via `github.upsertComment(issueNumber, "specify:summary", body)` on every terminal outcome (refined or needs_input). The body SHALL include: a link to the change folder, the `openQuestions`, `assumptions`, and `risks` lists, and a footer with `latencyMs` and the adapter's reported usage. Repeated runs SHALL update the same comment rather than creating duplicates.

#### Scenario: First run creates a comment
- **WHEN** the phase runs for the first time on a fresh issue
- **THEN** exactly one `upsertComment` call is made with markerId `specify:summary`

#### Scenario: Second run updates the same comment
- **WHEN** the phase runs a second time against the same ticket
- **THEN** the issue has exactly one comment whose body starts with `<!-- night-shift:marker=specify:summary -->`

#### Scenario: needs_input still comments
- **WHEN** the phase ends in `needs_input`
- **THEN** the comment body lists the open questions verbatim

### Requirement: SpecBundle branch and commitSha are populated

On a `refined` outcome, the returned `SpecBundle` SHALL have `branch = branchNameFor(ticket)` and a `commitSha` matching `^[0-9a-f]{7,40}$` returned by `git.writeTree`. `specPath` SHALL be the absolute path of the change folder. `openQuestions`, `assumptions`, `risks` SHALL reflect the META block (often empty on the refined path).

#### Scenario: commitSha is recorded from GitOps
- **WHEN** `git.writeTree` returns `{ sha: "abc1234" }`
- **THEN** the returned bundle has `commitSha: "abc1234"`

#### Scenario: Branch matches the deterministic helper
- **WHEN** the ticket id is `T-42` and the title is `Add OAuth flow`
- **THEN** `bundle.branch` is `night-shift/T-42-add-oauth-flow`

### Requirement: Error taxonomy

All errors thrown by the phase SHALL extend `SpecifyPhaseError` and set a stable `code` field from the set `"item_missing" | "parse" | "schema" | "provider" | "validation" | "git" | "io"`. Errors SHALL carry the `ticketId` when known and the elapsed latency in ms.

#### Scenario: Every error is discoverable by instanceof
- **WHEN** any error thrown by the phase is caught
- **THEN** `err instanceof SpecifyPhaseError` is true

#### Scenario: Codes are stable and enumerated
- **WHEN** each subclass is constructed
- **THEN** its `code` property matches the documented string

### Requirement: CLI wrapper

The system SHALL ship an executable `night-shift specify <projectItemId>` that loads `NightShiftConfig`, builds the real deps (GitHub client, Codex adapter for the specifier role, simple-git, openspec CLI subprocess), calls `runSpecifyPhase`, and exits with code `0` on `refined`, `1` on `needs_input`, and `2` on thrown errors. Unknown args SHALL print usage and exit `64`.

#### Scenario: Exit code on refined
- **WHEN** the CLI is invoked with a valid project item id and the phase resolves `status: "refined"`
- **THEN** the process exits with code `0`

#### Scenario: Exit code on needs_input
- **WHEN** the phase resolves `status: "needs_input"`
- **THEN** the process exits with code `1`

#### Scenario: Exit code on thrown error
- **WHEN** the phase throws a `SpecifyPhaseError`
- **THEN** the process exits with code `2` and the error message is printed to stderr

### Requirement: Observability events

The phase SHALL emit a `phase.started` event before the specifier call and a `phase.finished` event on every terminal path, using the `events` contract from `phase-contracts`. The `phase.finished` event SHALL include `phase: "specify"`, `status` (`"refined" | "needs_input" | "error"`), `ticketId`, `latencyMs`, and the adapter's reported token/cost usage.

#### Scenario: Started and finished are always paired on refined path
- **WHEN** a run completes with `refined`
- **THEN** the logger received exactly one `phase.started` and one `phase.finished` with `status: "refined"`

#### Scenario: Error path still emits phase.finished
- **WHEN** the phase throws after `phase.started` was emitted
- **THEN** a `phase.finished` event with `status: "error"` is emitted before the error propagates

### Requirement: Module boundary for src/phases/

`src/phases/**` SHALL import only from: `zod`, `node:fs`, `node:fs/promises`, `node:path`, `node:child_process`, `node:timers/promises`, `src/contracts/**`, `src/adapters/**`, `src/github/**`, `src/git/**`, `src/config/**`, and its own siblings. `src/phases/**` SHALL NOT import from `src/cli/**`. `src/git/**` SHALL import only from `zod`, `node:*`, and `src/contracts/**`.

#### Scenario: Boundary lint passes on the shipped module
- **WHEN** `npm run lint:boundaries` runs
- **THEN** `src/phases/**` and `src/git/**` produce no violations

#### Scenario: A disallowed import is caught
- **GIVEN** a hypothetical `src/phases/specify/foo.ts` that imports from `src/cli/index.js`
- **WHEN** `npm run lint:boundaries` runs
- **THEN** the script exits non-zero and names the violation
