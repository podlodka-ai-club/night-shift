## 1. Setup

- [x] 1.1 Add dependencies: `@octokit/core`, `@octokit/rest`, `@octokit/graphql`, `@octokit/webhooks`, `@octokit/auth-app`; devDep `nock`
- [x] 1.2 Extend `scripts/check-boundaries.mjs` with the `github` module rule
- [x] 1.3 Update `src/adapters/README.md` and root `README.md` Modules section to mention the new `src/github/` module (after it exists)

## 2. Errors

- [x] 2.1 Create `src/github/errors.ts`: `GitHubError` base + subclasses (`GitHubAuthError`, `GitHubPermissionError`, `GitHubNotFoundError`, `GitHubRateLimitError`, `GitHubTransientError`, `GitHubApiError`, `WebhookSignatureError`, `ConfigError`)
- [x] 2.2 Private-key redaction helper (`redactPem(s: string): string`) used when wrapping unknown errors
- [x] 2.3 Tests: every subclass has stable `code`; `instanceof GitHubError` holds; PEM redaction removes all PEM lines

## 3. Types and schemas

- [x] 3.1 Create `src/github/types.ts`: `StatusNameSchema` (7-value enum), `ProjectItemSchema`, `IssueSchema`, `LabelSchema`, `CommentSchema`, `PRRef` re-export from contracts
- [x] 3.2 Define `GitHubConfigSchema` with `appId`, `installationId`, `privateKey | privateKeyPath` (Zod refinement for XOR), `webhookSecret`, `owner`, `repo`, `projectNodeId`, optional `statusFieldName` (default `"Status"`), optional `manageStatusOptions` (default `true`)
- [x] 3.3 Export `ParsedWebhookEventSchema` discriminated union for `project_v2_item.changed`, `issues.opened|edited|labeled|closed`, `ignored`
- [x] 3.4 Tests: XOR refinement rejects both/neither; defaults applied; ParsedWebhookEventSchema covers all variants

## 4. Retry wrapper

- [x] 4.1 Create `src/github/retry.ts` exporting `retryable(fn, opts?)`
- [x] 4.2 Classify errors: network/5xx/secondary-rate-limit → retry; primary rate limit → `GitHubRateLimitError`; 4xx → `GitHubApiError`
- [x] 4.3 Honor `retry-after` and `x-ratelimit-reset` when present; otherwise `min(2^attempt * 250ms, 30s)` with ±25% jitter
- [x] 4.4 Cap at 5 attempts; throw `GitHubTransientError` with `attempts` set on overflow
- [x] 4.5 Tests using Vitest fake timers: retries on 500, honors retry-after, rejects with GitHubTransientError after 5 attempts, throws GitHubRateLimitError on primary limit, does not retry on 404

## 5. Webhook handler

- [x] 5.1 Create `src/github/webhooks.ts` exporting `handleWebhook({headers, rawBody, secret})`
- [x] 5.2 Signature verification with `node:crypto` HMAC-SHA256 + `timingSafeEqual`; throws `WebhookSignatureError` on missing/mismatch
- [x] 5.3 Parse `project_v2_item` payloads into `project_v2_item.changed` with old/new status resolved via a `statusNameLookup?: (optionId) => StatusName | undefined` callback (injectable so the client can feed resolved IDs)
- [x] 5.4 Parse `issues` actions: `opened`, `edited`, `labeled`, `closed`
- [x] 5.5 Return `{kind: "ignored", reason}` for any other `X-GitHub-Event`
- [x] 5.6 Expose `deliveryId` from `X-GitHub-Delivery` on every parsed event
- [x] 5.7 Tests: real HMAC roundtrip with valid and invalid secret; unknown event ignored; project_v2_item parsed end to end; issues labeled parsed

## 6. Projects v2 GraphQL module

- [x] 6.1 Create `src/github/projects.ts` with GraphQL query/mutation strings as tagged template literals
- [x] 6.2 `resolveStatusField(octokit, projectNodeId, fieldName): Promise<{fieldId, options}>` returning all options with ids + names
- [x] 6.3 `ensureStatusOptions(octokit, {fieldId, existing, required, colors})` runs a single mutation to add missing options (never deletes); returns updated option map
- [x] 6.4 `getItem(octokit, itemId)` and `getItemByIssue(octokit, repoOwner, repoName, issueNumber, projectNodeId)`
- [x] 6.5 `setStatus(octokit, {projectNodeId, itemId, fieldId, optionId})` mutation
- [x] 6.6 All calls wrapped via `retryable`
- [x] 6.7 Tests against a mocked GraphQL client: field resolution handles missing options; ensureStatusOptions sends one mutation with union; getItem returns a parsed ProjectItem; setStatus emits the correct mutation

## 7. Issues, labels, comments

- [x] 7.1 Create `src/github/issues.ts`
- [x] 7.2 `getIssue(octokit, owner, repo, number)` returning `IssueSchema`-parsed result
- [x] 7.3 `ensureLabel(octokit, owner, repo, name, color?, description?)` idempotent (catch 422 "already_exists")
- [x] 7.4 `addLabels`, `removeLabel` delegate to REST; `addLabels` calls `ensureLabel` first for each
- [x] 7.5 `upsertComment(octokit, owner, repo, number, markerId, body)`: list comments, find by marker prefix, update or create; ensure marker is always first line
- [x] 7.6 Tests: ensureLabel idempotent; addLabels creates missing; removeLabel tolerates 404 (label already absent); upsertComment dedup scenarios (no comment, existing comment, multiple comments where one matches)

## 8. Pull requests & branches

- [x] 8.1 Create `src/github/prs.ts`
- [x] 8.2 `createBranch(octokit, owner, repo, branch, fromRef?)`: resolve `fromRef` sha (default branch if omitted), create `refs/heads/<branch>`; idempotent when branch already at target sha, throws `GitHubApiError` otherwise
- [x] 8.3 `openPullRequest({owner, repo, head, base, title, body, draft?})` returns `PRRef`
- [x] 8.4 `setPullRequestReady(octokit, owner, repo, pullNumber, ready)`: GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft`
- [x] 8.5 Tests: createBranch happy path + idempotency; openPullRequest returns PRRef; setPullRequestReady toggles both directions

## 9. Client composition

- [x] 9.1 Create `src/github/client.ts` exporting `GitHubClient` interface and `buildGitHubClient(octokit, resolved, config)` internal constructor
- [x] 9.2 `createGitHubClient(config)` async factory in `src/github/index.ts`:
  - [x] 9.2.1 Validate `GitHubConfigSchema`
  - [x] 9.2.2 Resolve `privateKey` from file if `privateKeyPath` provided
  - [x] 9.2.3 Build Octokit with `@octokit/auth-app` installation strategy
  - [x] 9.2.4 `resolveStatusField` + `ensureStatusOptions` (or throw `ConfigError` when `manageStatusOptions=false`)
  - [x] 9.2.5 Return frozen client wiring projects/issues/prs modules
- [x] 9.3 Internal single-flight mutex (max 1 in-flight request per client)
- [x] 9.4 Export `redactPem`, error classes, `handleWebhook`, `StatusNameSchema`, `GitHubClient` type from `src/github/index.ts`
- [x] 9.5 Tests: factory resolves options with all present (no mutation); factory auto-creates missing options; factory throws ConfigError when manageStatusOptions=false and options missing; factory throws ConfigError when both privateKey and privateKeyPath provided

## 10. InMemoryFakeGitHubClient

- [x] 10.1 Create `src/github/fake.ts` exporting `InMemoryFakeGitHubClient`
- [x] 10.2 Seeded state: project items map, issues map (with labels + comments), PRs, labels, statusOptionIds preset
- [x] 10.3 Public `events: Array<{kind, args}>` appended on every mutation
- [x] 10.4 Implement every GitHubClient method against in-memory state
- [x] 10.5 `emitFakeWebhook(event)` helper returning the `ParsedWebhookEvent` shape for tests
- [x] 10.6 Tests: setStatus reflects in getItem; addLabels creates missing; upsertComment dedups; events log in order

## 11. Documentation

- [x] 11.1 `src/github/README.md`: interface overview, App setup steps (create app, install, grant perms, generate key), env var names, link to example config
- [x] 11.2 Extend `night-shift.config.example.ts` with a populated `github: { appId, privateKeyPath, ... }` block
- [x] 11.3 Update root `README.md` Modules section to list `src/github/`
- [x] 11.4 Extend `src/config/README.md` with the `github` section

## 12. Validation

- [x] 12.1 `npm run typecheck` passes
- [x] 12.2 `npm test` passes (all new suites + prior)
- [x] 12.3 `npm run lint:boundaries` passes (contracts + adapters + config + github)
- [x] 12.4 `openspec validate github-integration --strict` passes
