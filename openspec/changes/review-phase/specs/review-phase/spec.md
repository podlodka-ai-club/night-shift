## ADDED Requirements

### Requirement: runReviewPhase entry point

The system SHALL expose `runReviewPhase(input, deps): Promise<ReviewPhaseResult>` where `input` matches the existing `ReviewInputSchema` (`{ ticket, specBundle, pr, iteration }`) and `deps` injects every external effect (`github`, `agent`, `fs`, `clock`, `logger`, `config`). The function SHALL NOT perform any I/O outside of those deps. `ReviewPhaseResult` is a discriminated union of `{ status: "ready_to_merge", result: ReviewResult }`, `{ status: "needs_fix", result: ReviewResult }`, and `{ status: "escalated", result: ReviewResult }`. Every variant's `result` SHALL satisfy `ReviewResultSchema`.

#### Scenario: All I/O flows through deps
- **WHEN** the function runs with fake deps that record every call
- **THEN** `process.cwd`, `fetch`, `child_process`, and filesystem APIs outside `deps.fs` are never invoked

#### Scenario: Every variant carries a valid ReviewResult
- **WHEN** the phase returns any terminal variant
- **THEN** `ReviewResultSchema.parse(result)` succeeds for that variant

### Requirement: Entry requires status In review

On entry, the phase SHALL require the project item's status to be `In review`. Any other status (`Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `Ready to merge`, or `Blocked`) SHALL cause a `ReviewPhaseError` with `code: "validation"` thrown before any mutation, comment, or agent call.

#### Scenario: In review is accepted
- **GIVEN** an item whose current status is `In review`
- **WHEN** the phase runs
- **THEN** the reviewer agent is invoked and no entry-validation error is thrown

#### Scenario: Ready is rejected
- **GIVEN** an item whose current status is `Ready`
- **WHEN** the phase runs
- **THEN** `ReviewPhaseError` with `code: "validation"` is thrown; no `setStatus`, `createReview`, `upsertReviewComment`, or `agent.run` is emitted

#### Scenario: Blocked is rejected
- **GIVEN** an item whose current status is `Blocked`
- **WHEN** the phase runs
- **THEN** `ReviewPhaseError` with `code: "validation"` is thrown

### Requirement: Spec bundle and PR context are fetched via deps

The phase SHALL read each file listed in `input.specBundle` via `deps.fs`, fetch the PR diff via `github.getPullRequestDiff(pr.number)`, fetch the changed-files breakdown via `github.listChangedFiles(pr.number)`, and fetch existing review comments via `github.listReviewComments(pr.number)`. Review comments whose body starts with the Night-Shift marker prefix `<!-- night-shift:marker=` SHALL be filtered out before being included in the reviewer prompt. When any spec-bundle file is missing on disk the phase SHALL throw `ReviewPhaseError` with `code: "io"` before any GitHub mutation.

#### Scenario: Missing spec file is surfaced as io error
- **GIVEN** `input.specBundle.specPath` points at a folder whose `proposal.md` does not exist
- **WHEN** the phase runs
- **THEN** a `ReviewPhaseError` with `code: "io"` is thrown
- **AND** no `createReview`, `upsertReviewComment`, or `setStatus` is emitted

#### Scenario: Night-Shift review comments are filtered from the prompt
- **GIVEN** a PR with one prior `<!-- night-shift:marker=review:summary -->` comment and one human review comment
- **WHEN** the phase builds the reviewer prompt
- **THEN** the user message contains the human comment
- **AND** does not contain the Night-Shift marker comment

### Requirement: Diff is bounded before entering the prompt

The phase SHALL truncate the PR diff to at most `config.reviewPhase.maxDiffBytes` (default 65536 bytes) before including it in the reviewer prompt. When truncation occurs the prompt SHALL contain a sentinel line indicating the truncation byte count and the full changed-files breakdown (path + additions + deletions) from `listChangedFiles`.

#### Scenario: Short diff is passed through unchanged
- **GIVEN** a PR diff that is 4 KiB long
- **WHEN** the phase builds the reviewer prompt
- **THEN** the user message contains the diff verbatim and no truncation sentinel

#### Scenario: Long diff is truncated with a sentinel
- **GIVEN** a PR diff that is 200 KiB long and default `maxDiffBytes = 65536`
- **WHEN** the phase builds the reviewer prompt
- **THEN** the diff section of the user message is at most 65536 bytes
- **AND** the prompt contains a truncation sentinel noting the byte count
- **AND** the prompt includes the changed-files breakdown

### Requirement: Reviewer response is a schema-validated JSON payload

The phase SHALL invoke the reviewer agent with `TurnOpts.outputSchema = ReviewerResponseJsonSchema` (the JSON Schema projection of `ReviewerResponseSchema`). `finalText` SHALL be parsed as JSON and validated against `ReviewerResponseSchema` with shape `{ summary: string, findings: Finding[] }` where `Finding` matches the existing `FindingSchema` from `phase-contracts`. A non-JSON `finalText` SHALL cause a `ReviewAgentError` with `code: "parse"`. A JSON payload that fails the schema SHALL cause a `ReviewAgentError` with `code: "schema"` and the phase SHALL retry the reviewer exactly once with the Zod errors appended to the user message.

#### Scenario: Non-JSON response throws parse error
- **WHEN** the reviewer returns the literal string `LGTM`
- **THEN** a `ReviewAgentError` with `code: "parse"` is thrown and no GitHub mutation is emitted

#### Scenario: Schema-invalid JSON triggers one retry
- **WHEN** the reviewer returns `{ "summary": "ok", "findings": [{ "severity": "oops", "message": "x" }] }`
- **THEN** `ReviewAgentError` with `code: "schema"` is raised and `agent.run` is called exactly twice total
- **AND** the second prompt contains the Zod error text

#### Scenario: Empty findings list is a valid ready-to-merge signal
- **WHEN** the reviewer returns `{ "summary": "...", "findings": [] }`
- **THEN** parsing succeeds and the phase produces verdict `ready-to-merge`

### Requirement: Verdict is produced by decideVerdict

The phase SHALL call the pure `decideVerdict(findings, input.iteration)` helper from the `phase-contracts` capability with the parsed findings and the input iteration. The returned `Verdict` SHALL drive all subsequent mutations. The phase SHALL NOT re-implement the verdict rules.

#### Scenario: No errors yields ready-to-merge
- **WHEN** the reviewer returns only warning-level findings
- **THEN** the verdict is `"ready-to-merge"`

#### Scenario: Errors before iteration 2 yield needs-fix
- **GIVEN** `input.iteration = 1`
- **WHEN** the reviewer returns at least one error-level finding
- **THEN** the verdict is `"needs-fix"`

#### Scenario: Errors on iteration 2 or later yield escalate
- **GIVEN** `input.iteration = 2`
- **WHEN** the reviewer returns at least one error-level finding
- **THEN** the verdict is `"escalate"`

### Requirement: Ready-to-merge transition and PR mutations

On a `ready-to-merge` verdict, the phase SHALL call `github.setPullRequestReady(pr.number, true)`, submit a single top-level review via `github.createReview(pr.number, { event: "APPROVE", body })`, upsert line-scoped review comments (marker `review:finding`) for each finding that has a `location`, upsert a PR-level summary comment (marker `review:summary`) with the verdict, findings list, and footer, and transition the project item to `Ready to merge`.

#### Scenario: All actions are emitted in order
- **WHEN** the verdict is `ready-to-merge`
- **THEN** the recorded call order begins with `setPullRequestReady` or the reviews/comments (in the implementation's chosen sequence) and ends with `setStatus(itemId, "Ready to merge")`

#### Scenario: Summary comment is upserted
- **WHEN** the verdict is `ready-to-merge`
- **THEN** exactly one call to `upsertComment` with marker `review:summary` is made on the PR

#### Scenario: Warnings are still posted as line comments
- **GIVEN** a `ready-to-merge` verdict with two warning-level findings each carrying a `location`
- **WHEN** the phase finishes
- **THEN** `upsertReviewComment` is called twice with marker `review:finding`

### Requirement: Needs-fix transition and PR mutations

On a `needs-fix` verdict, the phase SHALL submit a single top-level review via `github.createReview(pr.number, { event: "REQUEST_CHANGES", body })`, upsert line-scoped review comments (marker `review:finding`) for each finding that has a `location`, upsert a PR-level summary comment (marker `review:summary`), and transition the project item to `Ready`. The phase SHALL NOT call `setPullRequestReady` (the PR is left in its current draft/ready state so `implement-phase` can push fixes).

#### Scenario: Status moves to Ready, not In progress
- **WHEN** the verdict is `needs-fix`
- **THEN** `setStatus(itemId, "Ready")` is called exactly once
- **AND** `setStatus(itemId, "In progress")` is NOT called

#### Scenario: REQUEST_CHANGES review is submitted
- **WHEN** the verdict is `needs-fix`
- **THEN** `createReview` is called once with `event: "REQUEST_CHANGES"`

#### Scenario: Findings with locations become line comments
- **GIVEN** three error-level findings, two with `location`
- **WHEN** the phase finishes
- **THEN** `upsertReviewComment` is called twice with marker `review:finding`
- **AND** the third finding appears only in the PR-level summary comment

### Requirement: Escalation transition and PR mutations

On an `escalate` verdict, the phase SHALL add the configured escalation label (default `night-shift:escalation`, overridable via `config.reviewPhase.escalationLabel`) to the ticket via `github.addLabels`, submit a single top-level review via `github.createReview(pr.number, { event: "COMMENT", body })`, upsert line-scoped review comments for findings with a `location`, upsert a PR-level marker comment (marker `review:escalation`), and transition the project item to `Blocked`. Re-entry after escalation is human-gated: the human resolves the issue and moves the item back to `In review`; the phase runs again and produces a new verdict.

#### Scenario: Escalation label is applied
- **WHEN** the verdict is `escalate`
- **THEN** `github.addLabels(issueNumber, [escalationLabel])` is called exactly once

#### Scenario: Item is transitioned to Blocked
- **WHEN** the verdict is `escalate`
- **THEN** `setStatus(itemId, "Blocked")` is called exactly once at the end

#### Scenario: Re-entry on Blocked is rejected
- **GIVEN** an escalated item whose status is still `Blocked`
- **WHEN** the phase is invoked again
- **THEN** `ReviewPhaseError` with `code: "validation"` is thrown (same as any other non-`In review` entry)

### Requirement: Review mutations are idempotent on re-run

Running the phase twice with the same `ReviewInput` SHALL NOT produce duplicate line comments or duplicate top-level reviews. `upsertReviewComment` SHALL be keyed by `markerId + path + line`. Top-level reviews authored by the app installation with a matching `review:summary` or `review:escalation` marker in the body SHALL be updated in place via `github.updateReview` rather than re-created; when GitHub disallows updating the existing review, the phase SHALL dismiss it and submit a new one.

#### Scenario: Second run updates the same line comments
- **GIVEN** a prior phase run that upserted two line comments on the PR
- **WHEN** the phase runs again with the same findings
- **THEN** no new review comments are created; the existing two are updated in place

#### Scenario: Second run updates the same top-level review
- **GIVEN** a prior phase run that submitted a `review:summary`-marked review
- **WHEN** the phase runs again with the same verdict
- **THEN** `createReview` is NOT called a second time
- **AND** the existing review's body is updated via `updateReview` (or a dismiss+resubmit when update is not allowed)

### Requirement: Error taxonomy

All errors thrown by the phase SHALL extend `ReviewPhaseError` and set a stable `code` field from the set `"validation" | "parse" | "schema" | "provider" | "github" | "io"`. Errors SHALL carry `ticketId`, `prNumber` (when known), `iteration`, and `latencyMs`.

#### Scenario: Every error is discoverable by instanceof
- **WHEN** any error thrown by the phase is caught
- **THEN** `err instanceof ReviewPhaseError` is true

#### Scenario: Codes are stable and enumerated
- **WHEN** each subclass is constructed
- **THEN** its `code` property matches the documented string

### Requirement: CLI wrapper

The system SHALL ship an executable `night-shift review <projectItemId> [--iteration <n>]` that loads `NightShiftConfig`, builds the real deps (GitHub client, Codex adapter for the `reviewer` role), resolves `iteration` from the flag when provided otherwise derives a default from `listReviews(pr.number)` counting Night-Shift-authored reviews, calls `runReviewPhase`, and exits with code `0` on `ready_to_merge`, `1` on `needs_fix`, `2` on thrown errors, `3` on `escalated`, and `64` on usage errors.

#### Scenario: Exit code on ready_to_merge
- **WHEN** the phase resolves `status: "ready_to_merge"`
- **THEN** the process exits with code `0`

#### Scenario: Exit code on needs_fix
- **WHEN** the phase resolves `status: "needs_fix"`
- **THEN** the process exits with code `1`

#### Scenario: Exit code on escalated
- **WHEN** the phase resolves `status: "escalated"`
- **THEN** the process exits with code `3`

#### Scenario: Exit code on thrown error
- **WHEN** the phase throws a `ReviewPhaseError`
- **THEN** the process exits with code `2` and the error message is printed to stderr

### Requirement: Observability events

The phase SHALL emit a `phase.started` event before the reviewer call and a `phase.finished` event on every terminal path, using the `events` contract. The `phase.finished` event SHALL include `phase: "review"`, `status` (`"ready_to_merge" | "needs_fix" | "escalated" | "error"`), `verdict` (`"ready-to-merge" | "needs-fix" | "escalate"` on non-error paths), `ticketId`, `prNumber`, `iteration`, `latencyMs`, and the adapter's reported token/cost usage.

#### Scenario: Started and finished are paired on ready_to_merge
- **WHEN** a run completes with `ready_to_merge`
- **THEN** the logger received exactly one `phase.started` and one `phase.finished` with `status: "ready_to_merge"` and `verdict: "ready-to-merge"`

#### Scenario: Error path still emits phase.finished
- **WHEN** the phase throws after `phase.started` was emitted
- **THEN** a `phase.finished` event with `status: "error"` is emitted before the error propagates

### Requirement: Module boundary for src/phases/review

`src/phases/review/**` SHALL import only from: `zod`, `node:*`, `src/contracts/**`, `src/adapters/**`, `src/github/**`, `src/config/**`, and its own siblings. `src/phases/review/**` SHALL NOT import from `src/cli/**`, `src/git/**`, `src/worktree/**`, or `src/quality-gates/**` (the review phase does not need a working tree).

#### Scenario: Boundary lint passes on the shipped module
- **WHEN** `npm run lint:boundaries` runs
- **THEN** `src/phases/review/**` produces no violations

#### Scenario: A disallowed import is caught
- **GIVEN** a hypothetical `src/phases/review/foo.ts` that imports from `src/git/index.js`
- **WHEN** `npm run lint:boundaries` runs
- **THEN** the script exits non-zero and names the violation
