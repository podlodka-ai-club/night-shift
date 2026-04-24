## 1. Setup

- [x] 1.1 Add dep `simple-git` (pinned); verify via `npm install`
- [x] 1.2 Extend `scripts/check-boundaries.mjs` with `phases` and `git` module rules
- [x] 1.3 Create empty module skeletons: `src/phases/specify/`, `src/git/`, `src/cli/`

## 2. Extend StatusName with Blocked

- [x] 2.1 Add `Blocked` to `STATUS_NAMES` in `src/github/types.ts` (append; don't reorder)
- [x] 2.2 Add `Blocked: "RED"` to `STATUS_COLORS` in `src/github/projects.ts`
- [x] 2.3 Preset `Blocked` option id in `createInMemoryFakeGitHubClient`
- [x] 2.4 Update `src/github/README.md` status list
- [x] 2.5 Tests: updated types.test + projects.test + fake.test cover the new value

## 2b. listComments on GitHubClient

- [x] 2b.1 Add `listComments(issueNumber): Promise<Comment[]>` to `GitHubClient` in `src/github/client.ts`
- [x] 2b.2 Implement in `src/github/issues.ts` using paginated `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` and the existing `retryable` helper
- [x] 2b.3 Wire through `src/github/factory.ts`
- [x] 2b.4 Implement on the in-memory fake (return seeded comments in insertion order)
- [x] 2b.5 Tests: paginates across 150 comments; empty issue returns `[]`; fake round-trips seeded bodies

## 3. GitOps

- [x] 3.1 Define `GitOps` interface in `src/git/index.ts` (`checkoutBranch`, `writeTree`, `currentHeadSha`)
- [x] 3.2 Implement `createSimpleGitOps({ repoRoot })` using `simple-git`; `writeTree` MUST stage the provided files, commit, and return the new HEAD sha
- [x] 3.3 Implement `createInMemoryFakeGitOps()` in `src/git/fake.ts`: records files + returns deterministic sha (`sha-1`, `sha-2`, …)
- [x] 3.4 Tests: fake round-trips files and shas; multiple writeTree calls increment the sha

## 4. Specifier errors

- [x] 4.1 Create `src/phases/specify/errors.ts`: `SpecifyPhaseError` base + `SpecifyItemMissingError`, `SpecifyAgentError`, `SpecifyValidationError`
- [x] 4.2 Each subclass has a stable `code` and optional `ticketId` / `latencyMs`
- [x] 4.3 Tests: codes enumerated; instanceof checks; message formatting

## 5. Prompt + structured response

- [x] 5.1 Create `src/phases/specify/prompt.ts`
- [x] 5.2 `renderUserMessage(ticket, comments, priorDraft?): string` embeds title/body/labels, a prose summary of the response schema, every non-Night-Shift comment in chronological order, and — when `priorDraft` is provided — a `## Current draft` section listing each existing change-folder file with its content
- [x] 5.3 Export `SpecifierResponseSchema` (Zod) with `files[{path, content}] + openQuestions + assumptions + risks`; path regex enforces `^(proposal|design|tasks|specs/[a-z0-9-]+/spec)\.md$`; refinements require `proposal.md` and `tasks.md`
- [x] 5.4 Export a JSON-Schema projection of `SpecifierResponseSchema` for `TurnOpts.outputSchema` (use `zod-to-json-schema` or hand-roll; decide in implementation)
- [x] 5.5 `parseResponse(finalText): SpecifierResponse` — `JSON.parse` then `SpecifierResponseSchema.parse`; throws `SpecifyAgentError` with `code: "parse"` or `"schema"`
- [x] 5.6 Tests: happy parse; non-JSON → `parse`; JSON missing `proposal.md` → `schema`; bad `path` (`../` or wrong extension) → `schema`; empty arrays in meta allowed

## 6. Phase core

- [x] 6.1 Create `src/phases/specify/phase.ts` exporting `runSpecifyPhase`
- [x] 6.2 Fetch item + issue + `listComments` via `deps.github`; throw `SpecifyItemMissingError` when no issue linked
- [x] 6.3 Assemble `Ticket` via existing contract helpers; filter out Night-Shift marker comments before rendering
- [x] 6.4 Pre-transition: `Backlog → Refinement`; skip when already in `Refinement`; throw `SpecifyPhaseError` (`code: "validation"`) on `Blocked|Refined|Ready|In progress|In review|Ready to merge`
- [x] 6.5 `createBranch(branchNameFor(ticket))` idempotent
- [x] 6.5b Read prior change folder via `deps.fs` if it exists on the ticket branch; pass contents to `renderUserMessage` as `priorDraft`
- [x] 6.6 Call specifier via `deps.agent.run(userMessage, { outputSchema: SpecifierResponseJsonSchema })`
- [x] 6.7 Parse response via `parseResponse`; write `files[]` via `deps.fs`; commit via `deps.git.writeTree`
- [x] 6.8 Validate via `deps.openspecCli.validate(name, { strict: true })`; on failure retry specifier once
- [x] 6.9 Emit `phase.started` and `phase.finished` observability events
- [x] 6.10 Upsert the ticket comment with marker `specify:summary`
- [x] 6.11 Terminal transition: `Refined` on success with empty open questions; `Blocked` on `needs_input`
- [x] 6.12 Return `SpecifyResult`; validate `refined` path with `validateSpecBundle`

## 7. OpenSpecCli wrapper

- [x] 7.1 Define `OpenSpecCli` interface (`validate(name, opts)` → `{ ok: true } | { ok: false, error: string }`)
- [x] 7.2 `createOpenSpecCli()` shells out to `npx openspec change validate <name> --strict` via `node:child_process.spawn`
- [x] 7.3 In-memory fake for unit tests (`FakeOpenSpecCli` with scripted responses)

## 8. Phase tests (unit)

- [x] 8.1 Happy path: refined outcome, all transitions in correct order, one comment upserted
- [x] 8.2 Item missing issue → throws, no status transitions, no branch creation
- [x] 8.3 Needs-input on retry exhaustion: validation fails twice → `status: "needs_input"`, comment contains validator errors, item transitioned to `Blocked`
- [x] 8.4 Already-in-Refinement item: no pre-transition mutation, happy path still succeeds
- [x] 8.5 Blocked-entry rejection: invoking the phase on a `Blocked` item throws `SpecifyPhaseError` with `code: "validation"`; no `setStatus`, `createBranch`, `agent.run`, or file write is emitted
- [x] 8.5b Backlog reset round-trip: item with a Night-Shift marker comment and a new operator reply runs the `Backlog → Refinement` pre-transition; the user message passed to `agent.run` contains the operator reply and omits the marker comment
- [x] 8.5c Reviewer revision round-trip: a previously-`Refined` ticket now in `Backlog` with an existing change folder and a new reviewer comment runs the phase; the user message contains both the reviewer comment and a `## Current draft` section seeded from the existing files; new specifier output overwrites the prior files
- [x] 8.6 Branch creation is idempotent (second run reuses branch)
- [x] 8.7 `phase.finished` emitted on every terminal path including thrown errors

## 9. Phase tests (integration with real openspec CLI)

- [x] 9.1 Wire `InMemoryFakeGitHubClient` + `InMemoryFakeAgentAdapter` + `InMemoryFakeGitOps` + real `createOpenSpecCli`
- [x] 9.2 Scripted adapter response produces a spec that passes strict validation → refined
- [x] 9.3 Scripted adapter response missing `## Purpose` → retry succeeds with fixed response → refined
- [x] 9.4 Scripted adapter response ambiguous → META open questions present → needs_input + Blocked
- [x] 9.5 Skip test when `openspec` CLI is not on PATH (guarded with `it.skipIf`)

## 10. CLI wrapper

- [x] 10.1 Create `src/cli/specify.ts` exporting a `main(argv, env): Promise<number>` returning the exit code
- [x] 10.2 Load `NightShiftConfig` via existing `loadConfig`
- [x] 10.3 Build real deps (GitHub client from `createGitHubClient`, Codex adapter for role `specifier`, simple-git, openspec CLI)
- [x] 10.4 Print a human summary on success; stderr the error on failure
- [x] 10.5 Tests: exit codes (0, 1, 2, 64); unknown args prints usage

## 11. Docs

- [x] 11.1 `src/phases/specify/README.md`: overview, deps table, CLI usage, test recipe
- [x] 11.2 `src/git/README.md`: GitOps surface + in-memory fake usage
- [x] 11.3 Update root `README.md` Modules section and Scripts section with `night-shift specify`

## 12. Validation

- [x] 12.1 `npm run typecheck` passes
- [x] 12.2 `npm test` passes (unit + integration where CLI available)
- [x] 12.3 `npm run lint:boundaries` passes (now covering `phases` and `git`)
- [x] 12.4 `openspec validate specify-phase --strict` passes
