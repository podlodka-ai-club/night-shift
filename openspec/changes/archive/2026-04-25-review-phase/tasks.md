## 1. Setup

- [x] 1.1 Extend `scripts/check-boundaries.mjs` to allow `src/phases/review/` under the `phases` rule (same import allow-list as `specify`/`implement` minus `git`/`worktree`/`quality-gates`)
- [x] 1.2 Create empty module skeleton `src/phases/review/`
- [x] 1.3 Add `"review"` entry to the `phase.started` / `phase.finished` discriminator type in `src/contracts/events.ts` if not already present; add a test
- [x] 1.4 Add `reviewPhase` sub-config to `NightShiftConfigSchema` (`maxDiffBytes: number (default 65536)`, `escalationLabel: string (default "night-shift:escalation")`)

## 2. GitHub client: PR review surfaces

- [x] 2.1 Add `getPullRequestDiff(pullNumber)` to `GitHubClient` in `src/github/client.ts`
- [x] 2.2 Implement in `src/github/prs.ts` using `GET /repos/{owner}/{repo}/pulls/{pull_number}` with `Accept: application/vnd.github.v3.diff`
- [x] 2.3 Add `listChangedFiles(pullNumber)` + `ChangedFileSchema` (Zod) in `src/github/types.ts`
- [x] 2.4 Implement `listChangedFiles` with pagination via `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`
- [x] 2.5 Add `listReviewComments(pullNumber)` + `ReviewCommentSchema`
- [x] 2.6 Implement pagination via `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`
- [x] 2.7 Add `upsertReviewComment(pullNumber, markerId, { path, line, body })`; keyed by `markerId + path + line`; creates via `POST .../pulls/{pull_number}/comments`, updates via `PATCH .../pulls/comments/{comment_id}`
- [x] 2.8 Add `createReview(pullNumber, { event, body })` and `listReviews(pullNumber)` + `updateReview(pullNumber, reviewId, { body })`
- [x] 2.9 Wire every new method through `src/github/factory.ts`
- [x] 2.10 Implement every new method on `InMemoryFakeGitHubClient` (seeded diff body, seeded changed-files list, in-memory review comment store keyed by `{markerId, path, line}`, in-memory review store)
- [x] 2.11 Tests: pagination for `listChangedFiles` and `listReviewComments`; idempotency for `upsertReviewComment` (re-run updates same comment; same marker on new line creates new comment); `createReview` happy paths for all three events; unsupported event rejected; `updateReview` changes body

## 3. Reviewer errors

- [x] 3.1 Create `src/phases/review/errors.ts`: `ReviewPhaseError` base + `ReviewAgentError`, `ReviewValidationError`, `ReviewGitHubError`, `ReviewIoError`
- [x] 3.2 Each subclass has stable `code` (`"validation" | "parse" | "schema" | "provider" | "github" | "io"`) and optional `ticketId` / `prNumber` / `iteration` / `latencyMs`
- [x] 3.3 Tests: codes enumerated; instanceof; message formatting includes prNumber + iteration when present

## 4. Prompt + structured response

- [x] 4.1 Create `src/phases/review/prompt.ts`
- [x] 4.2 `renderReviewerMessage(ticket, specBundle, diff, changedFiles, reviewComments, retryContext?)` embeds ticket, spec-bundle files inline, diff (with truncation sentinel if capped), filtered review comments (no Night-Shift markers), and a prose summary of the response schema
- [x] 4.3 Diff truncation: enforce `config.reviewPhase.maxDiffBytes`; include sentinel + changed-files breakdown when truncated
- [x] 4.4 Export `ReviewerResponseSchema` (Zod) = `{ summary: string, findings: FindingSchema[] }` (reuses `FindingSchema` from `phase-contracts`)
- [x] 4.5 Export a JSON-Schema projection of `ReviewerResponseSchema` for `TurnOpts.outputSchema` (via `zod-to-json-schema`)
- [x] 4.6 `parseReviewerResponse(finalText)` — `JSON.parse` then Zod parse; throw `ReviewAgentError` with `code: "parse" | "schema"`
- [x] 4.7 Tests: happy parse; non-JSON → `parse`; bad severity → `schema`; empty findings → valid; diff truncation sentinel appears when diff exceeds cap; files breakdown present when truncated

## 5. Rendering helpers

- [x] 5.1 Create `src/phases/review/rendering.ts`
- [x] 5.2 `renderSummaryBody(verdict, result, pr)` returns a markdown summary (verdict header, iteration, reviewer summary, findings list, latency/usage footer)
- [x] 5.3 `renderLineCommentBody(finding)` returns a short markdown body (message + optional italic `specRef`)
- [x] 5.4 Tests: snapshot for each verdict; warning-only summary on `ready-to-merge`; error list on `needs-fix` / `escalate`

## 6. Phase core

- [x] 6.1 Create `src/phases/review/phase.ts` exporting `runReviewPhase`
- [x] 6.2 Entry check: `item.status === "In review"` else throw `code: "validation"`
- [x] 6.3 Read spec-bundle files via `deps.fs`; throw `ReviewIoError` on missing
- [x] 6.4 Fetch diff via `deps.github.getPullRequestDiff`; fetch changed files; fetch review comments (filter Night-Shift markers)
- [x] 6.5 Emit `phase.started`
- [x] 6.6 Reviewer call: `deps.agent.run(msg, { outputSchema: ReviewerResponseJsonSchema })`; parse; on `code: "schema"` retry once with Zod errors
- [x] 6.7 Call `decideVerdict(findings, input.iteration)`
- [x] 6.8 Branch on verdict:
  - `ready-to-merge`: `setPullRequestReady(true)` → `createReview(APPROVE)` (or update via `listReviews`+`updateReview` if a Night-Shift marker-keyed review already exists) → upsert line comments for findings with `location` → upsert `review:summary` PR-level comment → `setStatus(Ready to merge)`
  - `needs-fix`: `createReview(REQUEST_CHANGES)` (with update guard) → upsert line comments → upsert `review:summary` → `setStatus(Ready)`
  - `escalate`: `addLabels([escalationLabel])` → `createReview(COMMENT)` (with update guard) → upsert line comments → upsert `review:escalation` → `setStatus(Blocked)`
- [x] 6.9 Emit `phase.finished` with verdict, status, prNumber, iteration, usage
- [x] 6.10 Return `ReviewPhaseResult` with `ReviewResultSchema`-compliant `result`

## 7. Phase tests (unit)

- [x] 7.1 Entry rejection on `Backlog` / `Refinement` / `Refined` / `Ready` / `In progress` / `Ready to merge` / `Blocked` — throws `validation`, no mutations
- [x] 7.2 Missing spec file → `ReviewIoError`, no mutations
- [x] 7.3 Happy `ready-to-merge`: empty findings → approve submitted, `setPullRequestReady(true)`, `setStatus(Ready to merge)`, summary comment exactly once
- [x] 7.4 Ready-to-merge with warnings: line comments upserted for each warning with `location`; findings without `location` only appear in the summary
- [x] 7.5 `needs-fix` on iteration 0: REQUEST_CHANGES submitted, `setStatus(Ready)`, line comments for findings with `location`
- [x] 7.6 `escalate` on iteration 2: escalation label added, `setStatus(Blocked)`, `review:escalation` marker comment
- [x] 7.7 Reviewer schema-invalid once → retry → happy
- [x] 7.8 Reviewer schema-invalid twice → `ReviewAgentError` `code: "schema"` bubbles up, no GitHub mutations
- [x] 7.9 Re-run idempotency: second run with same findings does not create duplicate line comments or duplicate top-level reviews
- [x] 7.10 Diff truncation: a 200 KB diff is capped at default 64 KiB in the prompt; sentinel + changed-files breakdown present
- [x] 7.11 `phase.finished` emitted on every terminal path including thrown errors

## 8. CLI wrapper

- [x] 8.1 Create `src/cli/review.ts` exporting `main(argv, env): Promise<number>`
- [x] 8.2 Parse `<projectItemId>` and optional `--iteration <n>` (integer ≥ 0); on missing iteration derive default from `listReviews(pr.number)` counting Night-Shift-authored reviews
- [x] 8.3 Build real deps (GitHub client, Codex adapter for `reviewer` role)
- [x] 8.4 Print verdict + PR link on success; stderr the error on failure
- [x] 8.5 Tests: exit codes (0 ready_to_merge, 1 needs_fix, 2 error, 3 escalated, 64 usage); unknown args prints usage; `--iteration` parsing (negative / non-integer rejected)

## 9. Docs

- [x] 9.1 `src/phases/review/README.md`: overview, deps table, CLI usage, verdict table, iteration model, test recipe
- [x] 9.2 Update root `README.md` Modules + Scripts sections with `night-shift review`
- [x] 9.3 Update `src/github/README.md` with the new PR-review surfaces

## 10. Validation

- [x] 10.1 `npm run typecheck` passes
- [x] 10.2 `npm test` passes
- [x] 10.3 `npm run lint:boundaries` passes (now covering `src/phases/review/`)
- [x] 10.4 `openspec change validate review-phase --strict` passes
