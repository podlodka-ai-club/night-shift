## Why

With `implement-phase` producing PRs in `In review`, we need the
reviewing agent that decides whether a PR is ready to merge or needs
another pass. Without it, PRs sit in `In review` indefinitely and the
orchestrator has nothing to trigger escalation on. This change ships
the `review-phase` module so `Ticket ──▶ [ Specify ] ──▶ [ Implement ]
──▶ [ Review ] ──▶ PR` completes end-to-end.

## What Changes

- Adds `runReviewPhase(input, deps): Promise<ReviewPhaseResult>` that:
  - Accepts a `ReviewInput` (`{ ticket, specBundle, pr, iteration }`)
    as already defined by the `phase-contracts` capability.
  - Requires `item.status` to be `In review` on entry; any other status
    is rejected with a typed `code: "validation"` error (no mutation).
    `In review` is the only accepted entry status — unlike implement's
    `Ready|In progress` dual, review has no crash-recovery second-entry
    state because the phase does not mutate the PR itself until the
    verdict.
  - Fetches the PR's diff, changed-files list, and existing review
    comments via new GitHub client surfaces (`getPullRequestDiff`,
    `listReviewComments`). Filters out Night-Shift marker comments
    (`<!-- night-shift:marker=… -->`) so prior iterations' review
    comments don't pollute the prompt.
  - Runs the reviewer agent (role `reviewer`) with a structured
    JSON response: a list of `Finding` objects (severity + message +
    optional file/line + optional spec reference) plus a summary. The
    existing pure `decideVerdict(findings, iteration)` helper then
    produces the terminal `Verdict`.
  - **Verdict routing:**
    - `"ready-to-merge"` → transitions the project item to
      `Ready to merge`, marks the PR as non-draft via
      `setPullRequestReady(prNumber, true)`, and upserts the
      `review:summary` marker comment on the PR plus line-scoped
      review comments for each warning-level finding.
    - `"needs-fix"` → upserts the `review:summary` marker comment
      on the PR with the error-level findings, upserts line-scoped
      review comments for each finding, and transitions the item back
      to `Ready`. The orchestrator then re-triggers `implement-phase`,
      which carries the increment to the next iteration.
    - `"escalate"` → adds the configured escalation label
      (default `night-shift:escalation`) to the ticket, upserts a
      `review:escalation` marker comment explaining why, and
      transitions the item to `Blocked`. Re-entry is human-gated: the
      reviewer resolves the issue and moves the item back to
      `In review`.
  - Tracks `iteration` entirely via the `ReviewInput` the orchestrator
    passes in — the phase itself is stateless. The M1 contract caps
    iterations at 2: iteration 0 and 1 may produce `"needs-fix"`;
    iteration 2 with errors produces `"escalate"` (enforced by
    `decideVerdict`).
  - Emits `phase.started` / `phase.finished` events with
    `phase: "review"` and the produced `verdict` using the existing
    `events` contract.
- Adds a `night-shift review <projectItemId> [--iteration <n>]` CLI
  exposing the phase, with exit codes `0` ready-to-merge, `1`
  needs-fix, `2` error, `3` escalate, `64` usage.
- Extends `scripts/check-boundaries.mjs` to allow `src/phases/review/`
  under the existing `phases` rule.

## Capabilities

### New Capabilities
- `review-phase`: the orchestrated flow that takes a PR from
  `implement-phase`, collects a structured set of findings from the
  reviewer agent, applies the pure verdict rules, and drives the
  resulting GitHub mutations (status transition, review comments,
  labels).

### Modified Capabilities
- `github-integration`: adds PR review surfaces to the `GitHubClient`:
  `getPullRequestDiff`, `listReviewComments`, `upsertReviewComment`
  (line-scoped, idempotent by marker + file + line), and `createReview`
  (submits a top-level `APPROVE` / `REQUEST_CHANGES` / `COMMENT`).

## Impact

- **Affected specs:** new `review-phase` capability;
  `github-integration` modified with the PR review surfaces.
- **Affected code:** new `src/phases/review/`; new
  `night-shift review` CLI under `src/cli/`; extends
  `src/github/prs.ts`, `src/github/client.ts`, and the in-memory
  fake client.
- **Affected dependencies:** no new runtime deps (reuses Octokit +
  existing fake infrastructure).
- **Non-goals:** automatic fix-loop scheduling (owned by the
  orchestration runtime), PR merging (humans still click merge),
  conflict resolution, and multi-reviewer workflows.
