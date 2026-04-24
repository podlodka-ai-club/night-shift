# Review Phase — Design

## Context

`implement-phase` hands off PRs in status `In review`. To close the M1
loop we need a phase that decides whether those PRs are ready to merge,
need another implementer pass, or must be escalated to a human. The
contract — `ReviewInput`, `ReviewResult`, `Finding`, `Verdict`, and the
pure `decideVerdict(findings, iteration)` helper — is already frozen in
`phase-contracts`. This change wires those contracts to GitHub and the
reviewer agent.

Same constraints as the earlier phase changes:

- All I/O flows through injected deps.
- Structured JSON response via `TurnOpts.outputSchema` + Zod validation.
- Explicit, stable error taxonomy.
- Stateless phase; iteration count comes from the orchestrator.

## Goals

1. `runReviewPhase(input, deps)` that takes `ReviewInput` and returns a
   discriminated `ReviewPhaseResult` (`ready_to_merge | needs_fix |
   escalated`), with the underlying `ReviewResult` included on every
   variant.
2. A minimal extension of `GitHubClient` for PR review operations
   (`getPullRequestDiff`, `listReviewComments`, `upsertReviewComment`,
   `createReview`).
3. CLI `night-shift review <projectItemId> [--iteration <n>]` matching
   the earlier phases' exit-code pattern.

## Non-Goals

- Owning the fix loop's scheduling (the orchestration runtime does
  that). This phase only reports a verdict and mutates state
  accordingly.
- Merging PRs. Humans (or a future automation) press the merge button.
- Detecting stale PRs, rebasing, or conflict resolution — those are
  implement-phase or orchestration concerns.
- Multi-reviewer or human-in-the-loop review aggregation.

## Key Design Decisions

### D1. Entry status

`In review` only. Any other status (`Backlog`, `Refinement`, `Refined`,
`Ready`, `In progress`, `Ready to merge`, `Blocked`) throws
`ReviewPhaseError` with `code: "validation"` before any mutation.
Unlike implement-phase, there is no crash-recovery second-entry status
because the phase does not mutate anything until the terminal verdict
is decided — re-running from `In review` is naturally idempotent.

### D2. Deps shape

```ts
interface ReviewDeps {
  github: GitHubClient;   // extended: getPullRequestDiff, listReviewComments,
                          //           upsertReviewComment, createReview
  agent: AgentAdapter;    // role: reviewer
  fs: FsOps;              // spec-bundle files are read from disk
  clock: { now(): Date };
  logger: EventLogger;
  config: NightShiftConfig;
}
```

### D3. Prompt and structured response

The reviewer receives a single user message containing:

- Ticket title + body + labels.
- The spec-bundle files (proposal / design / tasks / spec) inline.
- The PR unified diff (truncated to a configurable cap, default
  64 KiB; truncation is flagged in the prompt with a note so the
  reviewer knows it's partial).
- Existing non-Night-Shift review comments (for re-runs within the
  same iteration — rare but possible after crash recovery).
- A prose summary of the response schema.

Response schema:

```ts
export const ReviewerResponseSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(FindingSchema),   // from phase-contracts
});
```

`FindingSchema` is already frozen; we reuse it verbatim. Line numbers
on `location` SHALL be one-based, matching GitHub's review-comment
convention.

`parseResponse(finalText)` throws `ReviewAgentError` with `code:
"parse" | "schema"`. On `schema` we retry once with Zod errors appended
to the next prompt (same pattern as specify/implement).

### D4. Verdict routing

`Verdict` is produced by the existing pure `decideVerdict(findings,
iteration)`. We do not re-implement the rule in this phase — we call
the helper.

| Verdict          | PR action                                                                                    | Project item action                 | Label                             | Comment marker                 |
|------------------|----------------------------------------------------------------------------------------------|-------------------------------------|-----------------------------------|--------------------------------|
| `ready-to-merge` | `setPullRequestReady(true)` + `createReview(APPROVE)` + upsert warnings as line comments      | `setStatus → Ready to merge`        | —                                 | `review:summary`               |
| `needs-fix`      | `createReview(REQUEST_CHANGES)` + upsert errors + warnings as line comments                   | `setStatus → Ready`                 | —                                 | `review:summary`               |
| `escalate`       | `createReview(COMMENT)` with the escalation summary; line comments still upserted for errors  | `setStatus → Blocked`               | `addLabels([escalation])`         | `review:escalation`            |

Notes:

- **Line comments are idempotent.** `upsertReviewComment(pr, markerId,
  { path, line, body })` keys the marker by `markerId + path + line`
  so re-running the same iteration does not produce duplicate
  comments. A finding without `location` falls back to the PR-level
  summary comment and is not rendered as a line comment.
- **`createReview` is not idempotent by GitHub's design** (each call
  produces a new top-level review). The phase guards against duplicate
  top-level reviews by checking `listReviews(pr.number)` for an open
  review authored by the app installation with the same marker in its
  body before creating. On re-run the existing review's body is
  updated via `updateReview` (or dismissed + re-created if GitHub
  disallows the update).
- **`needs-fix` pushes the ticket back to `Ready`**, not `In progress`,
  so the orchestrator can schedule the next implementer pass through
  the normal `Ready → In progress` entry that `implement-phase`
  enforces.
- **`escalate` requires a human reset**: after resolving, the reviewer
  moves the item back to `In review` manually and optionally removes
  the escalation label. The phase can re-enter and produce a new
  verdict.

### D5. Iteration is owned by the caller

`ReviewInput.iteration` is a non-negative integer supplied by the
orchestrator. The phase does not track iterations itself. On the first
review it is `0`; after `implement-phase` re-runs and re-enters review
the orchestrator increments it. `decideVerdict` enforces the M1 cap of
2 iterations (iterations 0 and 1 may emit `"needs-fix"`; iteration 2
with errors emits `"escalate"`).

The CLI wrapper (see D10) defaults `iteration` to the maximum of
`(0, reviewCountAttributableToNightShift)` derived from
`listReviews(pr.number)` — this keeps the CLI usable without the
orchestrator but still respects past reviews.

### D6. Warnings vs errors

`decideVerdict` already encodes the rule: errors block, warnings do
not. This phase does not filter warnings out — they are surfaced as
line comments on every terminal path so humans see them even when the
verdict is `ready-to-merge`. Warnings therefore ride through to the
merge ramp.

### D7. Diff truncation

PR diffs can be huge. The phase truncates to `config.reviewPhase.maxDiffBytes`
(default 64 KiB) before including in the prompt. When truncated, the
prompt contains a `<!-- diff truncated at N bytes; full diff available
via listChangedFiles -->` sentinel and a breakdown of changed files
(path + additions + deletions) from `github.listChangedFiles`. The
reviewer is instructed to ask for specific files if it needs more
detail, but the phase does not iterate — requesting more detail
counts as a finding (`severity: "warning"`, message "diff truncated,
full review needs N KB more").

This is a deliberately simple M1 approach. Future iterations can add
multi-turn diff expansion.

### D8. Commenting

The PR-level summary comment (marker `review:summary` or
`review:escalation`) contains:

- The verdict header.
- The iteration number.
- The reviewer's `summary`.
- A numbered list of findings (severity + message + file:line + spec
  ref when present).
- Footer with `latencyMs` and the adapter's reported usage.

Line comments contain just the finding's `message` (plus `specRef` as
a trailing italic reference when present), keyed by marker
`review:finding`.

Ticket (issue) comments: the phase does NOT post to the issue — all
output lives on the PR. The summary can be mirrored to the issue by
the orchestration runtime if desired.

### D9. Error taxonomy

All errors extend `ReviewPhaseError` with `code` values:

- `"validation"` — entry-status rejection, unknown iteration.
- `"parse"` / `"schema"` / `"provider"` — agent failures (matches
  specify/implement).
- `"github"` — PR fetch / comment / review mutation failures.
- `"io"` — filesystem failures (missing spec-bundle file).

All errors carry `ticketId`, `prNumber` (when known), `iteration`, and
`latencyMs`.

### D10. Module layout

```
src/phases/review/
  index.ts            # public: runReviewPhase + ReviewPhaseResult + deps types
  phase.ts            # orchestration
  prompt.ts           # renderer + parseResponse
  rendering.ts        # comment body formatters
  errors.ts           # ReviewPhaseError hierarchy
  *.test.ts
src/cli/
  review.ts           # `night-shift review <itemId> [--iteration <n>]`
```

Boundaries:

- `src/phases/review/**` imports: `zod`, `node:*`, `src/contracts/**`,
  `src/adapters/**`, `src/github/**`, `src/config/**`, and own siblings.
  NOT `src/cli/**`.
- `src/cli/review.ts` imports `src/phases/review/**` and the real
  factories (same pattern as `specify` and `implement`).

### D11. Retry policy

One retry for reviewer `parse`/`schema` errors. No retry for `github`
mutations (those fall back to the existing `retryable` helper inside
the client). No retry on the agent's `findings` list itself — a valid
empty-findings response is a legitimate `ready-to-merge`.

Max adapter invocations per run: 2.

## Risks & Mitigations

- **Flooding the PR with duplicate comments on re-run** — `upsertReviewComment`
  is keyed by `markerId + path + line`; `createReview` is guarded
  against duplicate marker-keyed reviews; unit tests assert
  idempotency.
- **Reviewer hallucinates line numbers** — we pass the diff, so the
  reviewer sees actual line numbers. Findings with invalid
  `location.line` (beyond the file's length or outside the diff) fall
  back to PR-level summary rendering (we do not throw). The summary
  still includes them so context is not lost.
- **Huge diffs blow token budgets** — truncation to 64 KiB with a
  changed-files breakdown; reviewer can ask for more via findings.
- **Escalation label drift** — escalation label name is config-driven
  (`config.reviewPhase.escalationLabel`, default
  `night-shift:escalation`); the label is created on first use via the
  existing `addLabels` idempotency.
- **Iteration mismatch** — the phase trusts the caller's `iteration`
  value; the CLI derives a safe default. Unit tests pin the behaviour
  per iteration value.
