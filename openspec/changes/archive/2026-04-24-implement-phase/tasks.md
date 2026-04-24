## 1. Setup

- [x] 1.1 Extend `scripts/check-boundaries.mjs` with `worktree`, `quality-gates`, and update the `phases` rule to allow those siblings
- [x] 1.2 Create empty module skeletons: `src/phases/implement/`, `src/worktree/`, `src/quality-gates/`
- [x] 1.3 Add `"implement"` entry to the `phase.started` / `phase.finished` discriminator type in `src/contracts/events.ts` if not already present; add a test

## 2. Extend AgentRole with `spec-reviewer`

- [x] 2.1 Append `"spec-reviewer"` to the `AgentRoleSchema` enum in `src/config/roles.ts` (or wherever it lives)
- [x] 2.2 Update `NightShiftConfigSchema.roles` default to include a `spec-reviewer` entry mirroring `specifier`'s defaults
- [x] 2.3 Tests: `spec-reviewer` parses; unknown role still rejected; default config includes it

## 3. GitHub client extensions

- [x] 3.1 Add `pushBranch(branch, sha)` to `GitHubClient` in `src/github/client.ts`
- [x] 3.2 Implement in `src/github/prs.ts` using `POST /repos/{owner}/{repo}/git/refs` + `PATCH` for update, or `simple-git push` via the ticket worktree — pick the simpler route in implementation
- [x] 3.3 Add `upsertPullRequest(opts)` to `GitHubClient` wrapping the existing `openPullRequest` + a `listPullRequests` lookup by head branch
- [x] 3.4 Implement `GitHubPushRejectedError` subclass in `src/github/errors.ts`
- [x] 3.5 Wire both methods through `src/github/factory.ts`
- [x] 3.6 Implement both on `InMemoryFakeGitHubClient`
- [x] 3.7 Tests: `pushBranch` happy path; push rejection throws typed error; `upsertPullRequest` round-trips (create then update) and never creates duplicates

## 4. WorktreeOps

- [x] 4.1 Define `WorktreeOps` interface in `src/worktree/index.ts` (`create`, `remove`)
- [x] 4.2 Implement `createSimpleGitWorktreeOps({ repoRoot })` using `simple-git` (`git worktree add` / `git worktree remove`)
- [x] 4.3 Implement `createInMemoryFakeWorktreeOps()` in `src/worktree/fake.ts` using `node:fs.mkdtemp` + `rm -rf`
- [x] 4.4 Tests: real impl creates, lists, and removes a worktree against a temp repo; fake tracks create/remove calls

## 5. QualityGateRunner

- [x] 5.1 Define `QualityGateRunner` interface in `src/quality-gates/index.ts` (`run(gate, { cwd }): Promise<QualityGateResult>`)
- [x] 5.2 Implement `createNodeQualityGateRunner()` using `node:child_process.spawn`; truncate `logsTail` to 4 KiB; include a per-gate timeout from config (default 10 minutes)
- [x] 5.3 Implement `createInMemoryFakeQualityGateRunner()` with scripted per-gate responses
- [x] 5.4 Tests: passed / failed / skipped statuses; `logsTail` truncation at 4 KiB; timeout produces `failed` with a timeout log line

## 6. Implementer errors

- [x] 6.1 Create `src/phases/implement/errors.ts`: `ImplementPhaseError` base + `ImplementAgentError`, `ImplementValidationError`, `ImplementGitError`, `ImplementIoError`
- [x] 6.2 Each subclass has stable `code` and optional `ticketId` / `worktreePath` / `latencyMs`
- [x] 6.3 Tests: codes enumerated; instanceof checks; message formatting includes worktree path when present

## 7. Prompts + structured responses

- [x] 7.1 Create `src/phases/implement/prompt.ts`
- [x] 7.2 `renderImplementerMessage(ticket, specBundle, comments, retryContext?)` embeds ticket, the four spec-bundle files inline, filtered comments (no Night-Shift markers), and optional retry feedback
- [x] 7.3 `renderSpecReviewMessage(diff, specBundle)` embeds the unified diff and the spec-bundle files
- [x] 7.4 Export `ImplementerResponseSchema` (Zod) with strict `path` regex + absolute/`..` refinement
- [x] 7.5 Export `SpecReviewResponseSchema` (Zod)
- [x] 7.6 Export JSON-Schema projections for both via `zod-to-json-schema` (reuse the approach from `specify-phase`)
- [x] 7.7 `parseImplementerResponse(finalText)` and `parseSpecReviewResponse(finalText)` — `JSON.parse` then Zod parse; throw typed errors with `code: "parse" | "schema"`
- [x] 7.8 Tests: happy parses; non-JSON → `parse`; empty `filesWritten` → `schema`; path `../foo` → `schema`; absolute path → `schema`

## 8. Phase core

- [x] 8.1 Create `src/phases/implement/phase.ts` exporting `runImplementPhase`
- [x] 8.2 Read project item + issue + comments via `deps.github`; read spec-bundle files via `deps.fs`; throw `ImplementIoError` on missing files
- [x] 8.3 Pre-transition: `Ready → In progress`; skip when already in `In progress`; throw `code: "validation"` on any other status
- [x] 8.4 Create worktree via `deps.worktree.create({ branch, ticketId })`
- [x] 8.5 Emit `phase.started` observability event
- [x] 8.6 Implementer call 1: `deps.agent.run(msg, { outputSchema: ImplementerResponseJsonSchema })`; parse; on `code: "schema"` retry once with Zod errors in prompt
- [x] 8.7 Write `filesWritten[]` into the worktree via `deps.fs`; commit via `deps.git.writeTree`
- [x] 8.8 Compute diff via `deps.git.diffAgainstBase(baseBranch)` (extend `GitOps` with this method)
- [x] 8.9 Spec-reviewer call: parse; on non-empty `blockingIssues` retry implementer once, re-commit
- [x] 8.10 Run quality gates sequentially; on any `failed`, retry implementer once, re-commit, re-run all gates
- [x] 8.11 Push via `deps.github.pushBranch`; upsert PR via `deps.github.upsertPullRequest`
- [x] 8.12 Upsert `implement:summary` comment with PR link + gate table + spec-review summary + risks + latency/usage
- [x] 8.13 Terminal transition: `In review` on success; `Blocked` on `needs_input`
- [x] 8.14 On success: `deps.worktree.remove(path)`; on thrown error: leave worktree and attach path to the error
- [x] 8.15 Emit `phase.finished` observability event including PR number when available
- [x] 8.16 Return `ImplementResult`; `ImplementationResultSchema.parse` the `pr_opened` branch

## 9. GitOps extension

- [x] 9.1 Add `diffAgainstBase(baseBranch: string): Promise<string>` to `GitOps`
- [x] 9.2 Real impl: `simple-git.diff(["<merge-base>..HEAD"])`
- [x] 9.3 Fake impl: store last written tree and return a synthetic diff string derived from it
- [x] 9.4 Tests: fake returns reproducible diff; real impl exercised via the integration test below

## 10. Phase tests (unit)

- [x] 10.1 Happy path: `pr_opened`, all transitions in order, PR upserted exactly once, worktree removed
- [x] 10.2 Missing spec-bundle file → `ImplementIoError`, no transitions, no worktree
- [x] 10.3 Entry rejection on `Backlog` / `Refined` / `In review` / `Blocked` — throws `validation`
- [x] 10.4 Already-in-progress item: no pre-transition, happy path still succeeds
- [x] 10.5 Implementer schema-invalid once → retry → succeeds
- [x] 10.6 Implementer schema-invalid twice → `ImplementAgentError` `code: "schema"` bubbles up, worktree kept, path on error
- [x] 10.7 Spec-review blocks once, retry resolves → `pr_opened`
- [x] 10.8 Spec-review blocks twice → `needs_input` with `blockingIssues`
- [x] 10.9 Quality gate fails once, retry fixes → `pr_opened`
- [x] 10.10 Quality gate fails twice → `needs_input` with gate failures in `openQuestions`, item `Blocked`
- [x] 10.11 PR idempotency: second run reuses same PR number
- [x] 10.12 `phase.finished` emitted on every terminal path including thrown errors

## 11. Phase tests (integration)

- [x] 11.1 Wire `InMemoryFakeGitHubClient` + `InMemoryFakeAgentAdapter` + `InMemoryFakeGitOps` + `InMemoryFakeWorktreeOps` + `InMemoryFakeQualityGateRunner`
- [x] 11.2 Scripted adapter writes a minimal valid patch; scripted gates pass → `pr_opened`
- [x] 11.3 Scripted adapter path-escape → `schema` error, no files written, worktree kept
- [x] 11.4 Scripted gate `typecheck` fails with 8 KiB of logs → retry succeeds → `pr_opened`; assert `logsTail` was truncated at 4 KiB in the prompt

## 12. CLI wrapper

- [x] 12.1 Create `src/cli/implement.ts` exporting `main(argv, env): Promise<number>`
- [x] 12.2 Build real deps (GitHub client, Codex adapters for `implementer` and `spec-reviewer`, simple-git, real worktree, real gates)
- [x] 12.3 Print the PR link on success; stderr the error + `worktreePath` on failure
- [x] 12.4 Tests: exit codes (0, 1, 2, 64); unknown args prints usage

## 13. Docs

- [x] 13.1 `src/phases/implement/README.md`: overview, deps table, CLI usage, test recipe, worktree debugging notes
- [x] 13.2 `src/worktree/README.md`: WorktreeOps surface + in-memory fake usage
- [x] 13.3 `src/quality-gates/README.md`: runner surface, timeout policy, log truncation
- [x] 13.4 Update root `README.md` Modules + Scripts sections with `night-shift implement`

## 14. Validation

- [x] 14.1 `npm run typecheck` passes
- [x] 14.2 `npm test` passes (unit + integration)
- [x] 14.3 `npm run lint:boundaries` passes (now covering `worktree`, `quality-gates`, widened `phases`)
- [x] 14.4 `openspec change validate implement-phase --strict` passes
