# phase-contracts Specification

## Purpose
TBD - created by archiving change phase-contracts. Update Purpose after archive.
## Requirements
### Requirement: Canonical Ticket model

The system SHALL define a single `Ticket` type that represents a unit of work to be processed by Night Shift. The type SHALL carry source-agnostic fields (`id`, `title`, `description`, `status`, `labels`, `url`) and a discriminated `sourceRef` for source-specific metadata. All M1 modules SHALL import this type rather than redefining equivalent shapes.

#### Scenario: Ticket round-trips through JSON
- **WHEN** a valid `Ticket` value is serialized with `JSON.stringify` and parsed back with the Zod schema
- **THEN** the parsed value equals the original and no validation error is thrown

#### Scenario: Ticket missing required fields is rejected
- **WHEN** an object without `id` (or any other required field) is passed to the Ticket schema's `parse` method
- **THEN** a `ZodError` is thrown naming the missing field

#### Scenario: Ticket with unknown source discriminator is rejected
- **WHEN** a Ticket payload has `source: "gitlab"` but no registered `sourceRef` variant for that value
- **THEN** parsing fails with an error identifying the unsupported source

### Requirement: Closed TicketStatus enum with declared transitions

The system SHALL define `TicketStatus` as a closed enum with exactly these values: `Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `In review`, `Ready to merge`. The system SHALL export a `TICKET_STATUS_TRANSITIONS` table listing all allowed `(from, to)` pairs, and a pure helper `canTransition(from, to): boolean` that returns `true` only for listed pairs.

#### Scenario: Happy-path transitions are allowed
- **WHEN** `canTransition` is called with any adjacent pair on the forward path (`Backlog → Refinement`, `Refinement → Refined`, `Refined → Ready`, `Ready → In progress`, `In progress → In review`, `In review → Ready to merge`)
- **THEN** it returns `true`

#### Scenario: Escalation transitions are allowed
- **WHEN** `canTransition` is called with `In review → Refinement` or `In review → Ready`
- **THEN** it returns `true`

#### Scenario: Skipping phases is rejected
- **WHEN** `canTransition` is called with `Backlog → Ready` (or any non-listed pair)
- **THEN** it returns `false`

### Requirement: Deterministic branch naming

The system SHALL provide a pure function `branchNameFor(ticket): string` that produces `night-shift/<ticket-id>-<slug>` where `<slug>` is derived from `ticket.title` by lowercasing, replacing runs of non-`[a-z0-9]` characters with a single `-`, trimming leading/trailing `-`, and truncating to 50 characters.

#### Scenario: Simple title produces clean slug
- **WHEN** `branchNameFor({ id: "T-12", title: "Add user login", ... })` is called
- **THEN** the result is `night-shift/T-12-add-user-login`

#### Scenario: Special characters and spaces are normalised
- **WHEN** `branchNameFor({ id: "T-7", title: "Fix: FOO/bar   (quick!)", ... })` is called
- **THEN** the result is `night-shift/T-7-fix-foo-bar-quick`

#### Scenario: Long titles are truncated
- **WHEN** `branchNameFor` is called with a 200-character title
- **THEN** the slug portion is at most 50 characters with no trailing `-`

#### Scenario: Determinism
- **WHEN** `branchNameFor` is called twice with the same ticket
- **THEN** both calls return the exact same string

### Requirement: SpecifyInput and SpecBundle contracts

The system SHALL define `SpecifyInput = { ticket: Ticket }` as the Specify phase input and `SpecBundle` as its output with fields: `specPath: string` (absolute path inside the repo), `branch: string` (matching `branchNameFor(ticket)`), `openQuestions: string[]`, `assumptions: string[]`, `risks: string[]`, `commitSha: string`. Both SHALL have Zod schemas that parse external payloads.

#### Scenario: Valid SpecBundle parses
- **WHEN** a fully-populated `SpecBundle` JSON object is parsed
- **THEN** parsing succeeds and the result is structurally equal to the input

#### Scenario: SpecBundle with empty question/assumption/risk arrays is valid
- **WHEN** `openQuestions`, `assumptions`, and `risks` are all `[]`
- **THEN** parsing succeeds (empty arrays are allowed)

#### Scenario: SpecBundle branch must match ticket
- **WHEN** a `validateSpecBundle(ticket, bundle)` helper is called with `bundle.branch !== branchNameFor(ticket)`
- **THEN** it returns an error indicating branch mismatch

### Requirement: ImplementInput and ImplementationResult contracts

The system SHALL define `ImplementInput = { ticket: Ticket, specBundle: SpecBundle }` and `ImplementationResult` with: `pr: { number: number, url: string, branch: string, baseBranch: string, headSha: string }`, `qualityGates: QualityGateResult[]`, `specReview: { subagentSummary: string, blockingIssues: string[] }`, `summary: string`. Each `QualityGateResult` SHALL carry `name: string`, `status: "passed" | "failed" | "skipped"`, `durationMs: number`, and optional `logsTail: string` (max 4096 chars) and `logsPath: string`.

#### Scenario: Valid ImplementationResult parses
- **WHEN** a fully-populated `ImplementationResult` JSON object is parsed
- **THEN** parsing succeeds

#### Scenario: QualityGateResult with oversized logsTail is rejected
- **WHEN** `logsTail` exceeds 4096 characters
- **THEN** parsing fails with a length error

#### Scenario: Empty qualityGates is valid
- **WHEN** `qualityGates` is `[]`
- **THEN** parsing succeeds (a repo may disable all gates)

### Requirement: ReviewInput, ReviewResult, and verdict rules

The system SHALL define `ReviewInput = { ticket: Ticket, specBundle: SpecBundle, pr: PRRef, iteration: number }` and `ReviewResult = { verdict: "ready-to-merge" | "needs-fix" | "escalate", findings: Finding[], iteration: number, summary: string }`. `Finding` SHALL have `severity: "error" | "warning"`, `message: string`, and optional `location: { file: string, line?: number }` and `specRef: string`. The system SHALL provide a pure helper `decideVerdict(findings, iteration): Verdict` implementing: if no `error` findings → `"ready-to-merge"`; else if `iteration < 2` → `"needs-fix"`; else → `"escalate"`. Warnings never block and never change the verdict.

#### Scenario: No errors yields ready-to-merge regardless of warnings
- **WHEN** `decideVerdict([{severity:"warning",...}, {severity:"warning",...}], 0)` is called
- **THEN** the result is `"ready-to-merge"`

#### Scenario: Errors on first pass yield needs-fix
- **WHEN** `decideVerdict([{severity:"error",...}], 0)` is called
- **THEN** the result is `"needs-fix"`

#### Scenario: Errors on second pass still yield needs-fix
- **WHEN** `decideVerdict([{severity:"error",...}], 1)` is called
- **THEN** the result is `"needs-fix"`

#### Scenario: Errors on third pass escalate
- **WHEN** `decideVerdict([{severity:"error",...}], 2)` is called
- **THEN** the result is `"escalate"`

#### Scenario: Info severity is not accepted
- **WHEN** a Finding with `severity: "info"` is parsed
- **THEN** parsing fails

### Requirement: PhaseEvent observability contract

The system SHALL define `PhaseEvent` as a discriminated union (by `kind`) with variants `PhaseStarted`, `PhaseCompleted`, `PhaseFailed`, `AgentInvoked`, `QualityGateEvaluated`. Every variant SHALL include common fields: `ticketId: string`, `phase: "specify" | "implement" | "review"`, `profileId: string`, `ts: string` (ISO-8601), `runId: string`. The system SHALL define an `EventSink` interface with a single `emit(event: PhaseEvent): void | Promise<void>` method.

#### Scenario: All five variants parse
- **WHEN** one example of each variant is parsed
- **THEN** parsing succeeds and the variant is narrowed by `kind`

#### Scenario: Event without profileId is rejected
- **WHEN** any PhaseEvent variant is parsed without `profileId`
- **THEN** parsing fails (profileId is required; callers may pass `"default"` in M1)

#### Scenario: Timestamps are strings, not Dates
- **WHEN** a PhaseEvent is parsed with `ts` as a `Date` object
- **THEN** parsing fails; ISO-8601 string is required

#### Scenario: Cost is integer micro-USD
- **WHEN** `PhaseCompleted` or `AgentInvoked` is parsed with `cost: 0.01` (float USD)
- **THEN** parsing fails; integer micro-USD is required

#### Scenario: EventSink emit is invoked
- **WHEN** a test sink is passed where `emit` records calls, and a `PhaseStarted` is emitted through it
- **THEN** `emit` is invoked exactly once with the event

### Requirement: JSON-safe contracts

Every contract type defined by this capability SHALL be serializable with `JSON.stringify` and re-parsable to an identical structure. No contract SHALL contain `Date`, `bigint`, `Map`, `Set`, `undefined`-valued required fields, functions, or symbols.

#### Scenario: Round-trip preserves structure
- **WHEN** any exported contract example is passed through `JSON.parse(JSON.stringify(x))` and then `.parse()`d by its schema
- **THEN** parsing succeeds and the result is structurally equal to the original

### Requirement: Contracts module boundary

The system SHALL place contract definitions in a single module (`src/contracts/`) that exports Zod schemas, inferred TypeScript types, and the pure helpers specified above (`canTransition`, `branchNameFor`, `decideVerdict`, `validateSpecBundle`, cost conversion helpers). The module SHALL have zero runtime dependencies on agent providers, GitHub, Temporal, or the filesystem. The module SHALL NOT perform any I/O.

#### Scenario: Contracts module has no I/O dependencies
- **WHEN** the contracts module is imported in a test environment with no network, no filesystem, and no environment variables
- **THEN** all exports load successfully and helpers execute without error

#### Scenario: Contracts module has no forbidden imports
- **WHEN** the dependency graph of `src/contracts/` is inspected
- **THEN** it imports only `zod` and other files within `src/contracts/` (no Temporal, no Octokit, no agent SDKs, no `fs`, no `child_process`)

