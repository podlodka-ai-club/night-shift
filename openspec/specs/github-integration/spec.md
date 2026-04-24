# github-integration Specification

## Purpose

Provides the typed, testable GitHub integration layer that every phase relies
on for Projects v2 state transitions, issue/PR operations, labels, comments,
branches, and webhook handling. All GitHub I/O is isolated behind a single
`GitHubClient` interface so phases never import Octokit directly, and so a
deterministic in-memory fake can drive tests end-to-end.
## Requirements
### Requirement: GitHubClient interface

The system SHALL expose a `GitHubClient` interface that covers every GitHub operation phases and the runtime need: reading project items, transitioning status, reading issues, creating branches, upserting comments, managing labels, and opening pull requests. No code outside `src/github/**` SHALL import Octokit or `@octokit/*` directly.

#### Scenario: Public surface is the only supported entry point
- **WHEN** a boundary check is run on the repository
- **THEN** `@octokit/*` and `@octokit/graphql` imports are only present under `src/github/**`

#### Scenario: Interface is implementable by a fake
- **WHEN** `InMemoryFakeGitHubClient` is substituted for the real client in a phase test
- **THEN** the phase runs without changes

### Requirement: createGitHubClient resolves project status options at startup

The system SHALL provide `createGitHubClient(config): Promise<GitHubClient>` that authenticates against GitHub as an App installation, queries the configured project's status single-select field, and exposes `statusOptionIds: Readonly<Record<StatusName, string>>` covering all 8 status names (`Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `In review`, `Ready to merge`, `Blocked`). When `config.github.manageStatusOptions` is `true` (the default) and any status option is missing, the factory SHALL create the missing options via GraphQL mutation before returning. When `manageStatusOptions` is `false` and any required option is missing, the factory SHALL throw `ConfigError` with the list of missing option names.

#### Scenario: All options present, no mutation performed
- **GIVEN** a project whose status field already has all 8 options including `Blocked`
- **WHEN** `createGitHubClient(config)` runs
- **THEN** no create-option mutation is sent and the returned client's `statusOptionIds` has all 8 keys

#### Scenario: Missing options auto-created with default policy
- **GIVEN** a project whose status field is missing `Blocked`
- **WHEN** `createGitHubClient(config)` runs with `manageStatusOptions: true`
- **THEN** exactly one update mutation is sent containing the union of existing and required options
- **AND** the returned client's `statusOptionIds["Blocked"]` is non-empty

#### Scenario: Missing options with manageStatusOptions=false throws
- **GIVEN** a project whose status field is missing `Blocked`
- **WHEN** `createGitHubClient(config)` runs with `manageStatusOptions: false`
- **THEN** a `ConfigError` is thrown whose message names `Blocked`
- **AND** no mutation is sent

### Requirement: Status transitions are typed and idempotent

The client's `setStatus(itemId, status)` SHALL accept only the 8 documented status names (a Zod-enforced enum) and SHALL perform a `updateProjectV2ItemFieldValue`-equivalent mutation using the pre-resolved option IDs. Calling `setStatus` with the same value the item already has SHALL be a no-op that does not count against rate limits (client-side check when last-known state is available).

#### Scenario: Unknown status rejected before a network call
- **WHEN** `setStatus("PVTI_...", "Wontfix")` is called
- **THEN** a validation error is thrown before any request is sent

#### Scenario: Moving to a new status produces one mutation
- **GIVEN** an item whose known status is `Refinement`
- **WHEN** `setStatus(itemId, "Blocked")` is called
- **THEN** exactly one GraphQL mutation is sent with the pre-resolved option ID for `Blocked`

### Requirement: Issue and PR operations

The client SHALL provide `getIssue`, `createBranch`, `addLabels`, `removeLabel`, `upsertComment`, `openPullRequest`, and `setPullRequestReady`. `addLabels` SHALL create missing labels on first use (idempotent via `ensureLabel`). `openPullRequest` SHALL return a typed `PRRef` (as defined in `phase-contracts`).

#### Scenario: addLabels creates a missing label
- **GIVEN** a repo that does not have the label `night-shift:escalation`
- **WHEN** `addLabels(123, ["night-shift:escalation"])` is called
- **THEN** the label is created with a deterministic color and description
- **AND** the issue ends up with that label applied

#### Scenario: createBranch returns the ref and sha
- **WHEN** `createBranch("night-shift/t-1-slug")` is called on a repo whose default branch has sha `abc`
- **THEN** a new ref `refs/heads/night-shift/t-1-slug` is created pointing at `abc`
- **AND** the returned value is `{ ref: "refs/heads/night-shift/t-1-slug", sha: "abc" }`

#### Scenario: openPullRequest returns a PRRef
- **WHEN** `openPullRequest({ head, base, title, body })` is called
- **THEN** the returned value matches `PRRefSchema` from `phase-contracts`

### Requirement: Comment upsert uses an HTML marker

`upsertComment(issueNumber, markerId, body)` SHALL list the issue's comments, find the first whose body begins with `<!-- night-shift:marker=<markerId> -->`, and update it with the new body (marker preserved) if present; otherwise create a new comment whose body begins with that marker. Re-running the same upsert with the same `markerId` SHALL not create duplicates.

#### Scenario: First invocation creates a comment
- **GIVEN** an issue with no comments
- **WHEN** `upsertComment(1, "specify:open-questions", "Q1: ...")` is called
- **THEN** one comment is created whose body starts with `<!-- night-shift:marker=specify:open-questions -->`

#### Scenario: Second invocation updates the existing comment
- **GIVEN** an issue with the marker comment above
- **WHEN** `upsertComment(1, "specify:open-questions", "Updated")` is called
- **THEN** no new comment is created
- **AND** the existing comment body is updated and still starts with the marker

### Requirement: Webhook handler is a pure function

The system SHALL export `handleWebhook({ headers, rawBody, secret }): ParsedWebhookEvent`. It SHALL verify the `X-Hub-Signature-256` header using HMAC-SHA256 of `rawBody` keyed by `secret`, using a constant-time comparison. On verification failure it SHALL throw `WebhookSignatureError`. On success it SHALL return a discriminated union covering at minimum: `project_v2_item.changed` (with `itemId`, `previousStatus?`, `currentStatus?`, `projectNodeId`, `deliveryId`), `issues.opened|edited|labeled|closed` (with `issueNumber`, `repoOwner`, `repoName`, `deliveryId`), and `ignored` (with `reason`).

#### Scenario: Missing signature header rejected
- **WHEN** `handleWebhook` is called without `X-Hub-Signature-256`
- **THEN** a `WebhookSignatureError` is thrown

#### Scenario: Mismatched signature rejected
- **WHEN** `handleWebhook` is called with a body signed using a different secret
- **THEN** a `WebhookSignatureError` is thrown

#### Scenario: Unknown event type is ignored
- **WHEN** a valid signature is present but `X-GitHub-Event` is `star`
- **THEN** `{kind: "ignored", reason: "event not handled: star"}` is returned and nothing throws

#### Scenario: project_v2_item status change parsed
- **WHEN** a valid `project_v2_item` payload with a single-select status change is provided
- **THEN** the result is `{kind: "project_v2_item.changed", ...}` with `previousStatus` and `currentStatus` resolved to `StatusName` values when they match the configured mapping

### Requirement: No HTTP server is shipped

The `src/github/` module SHALL NOT include or depend on any HTTP server. Transport (Express/Fastify/bare http/smee) is the caller's responsibility.

#### Scenario: No HTTP server imports
- **WHEN** the `src/github/**` import graph is inspected
- **THEN** no import resolves to a package providing an HTTP server (`express`, `fastify`, `koa`, `node:http` `createServer` usage)

### Requirement: Retry policy with jitter and bounded attempts

Every outgoing REST and GraphQL call SHALL pass through a `retryable(fn, opts)` wrapper that retries on network errors, 5xx responses, and GitHub secondary rate-limit signals. The policy SHALL respect `retry-after` seconds and `x-ratelimit-reset` epoch seconds when present; otherwise it SHALL use exponential backoff `min(2^attempt * 250ms, 30s)` with ±25% jitter. Maximum 5 attempts (4 retries). Primary rate-limit exhaustion SHALL throw `GitHubRateLimitError` immediately. 4xx responses (other than secondary rate-limit) SHALL throw `GitHubApiError` without retry.

#### Scenario: 500 triggers retry
- **GIVEN** a mocked endpoint returning 500 twice then 200
- **WHEN** a request is made through `retryable`
- **THEN** 3 attempts are made and the final 200 is returned

#### Scenario: Max attempts exceeded
- **GIVEN** a mocked endpoint returning 500 six times
- **WHEN** a request is made through `retryable`
- **THEN** after 5 attempts a `GitHubTransientError` is thrown with `attempts: 5`

#### Scenario: Retry-after is honored
- **GIVEN** a mocked endpoint returning 503 with `retry-after: 1`
- **WHEN** `retryable` runs with a fake clock
- **THEN** the next attempt happens no sooner than 1000ms later

#### Scenario: Primary rate limit throws immediately
- **GIVEN** a response with `x-ratelimit-remaining: 0` and reset 5s in the future (not a secondary rate limit)
- **WHEN** the call is made
- **THEN** `GitHubRateLimitError` is thrown with `resetAt` set and no retry is performed

### Requirement: Typed error hierarchy

All errors thrown by the GitHub module SHALL extend a base `GitHubError` and set a stable `code` field from the set `"auth" | "forbidden" | "not_found" | "rate_limit" | "transient" | "api" | "webhook_signature" | "config"`. Every error SHALL carry a message, may carry a `cause`, and SHALL NOT contain raw private-key material.

#### Scenario: Errors are discoverable by instanceof
- **WHEN** any error thrown by the module is caught
- **THEN** `err instanceof GitHubError` is true

#### Scenario: Code is stable and enumerated
- **WHEN** each error subclass is constructed
- **THEN** its `code` property matches the documented string

#### Scenario: Private key never appears in errors
- **GIVEN** a config pointing at a PEM private key containing the string `-----BEGIN RSA PRIVATE KEY-----`
- **WHEN** any error is thrown during authentication or a request
- **THEN** the error message, stack, and `cause.toString()` do not contain any line of the PEM

### Requirement: InMemoryFakeGitHubClient

The system SHALL provide `InMemoryFakeGitHubClient implements GitHubClient`. It SHALL expose a public `events` array recording every mutating call (in order) with `{kind, args}`. It SHALL support seeding issues and project items, and SHALL preset `statusOptionIds` for the 7 documented statuses. All methods SHALL return resolved promises and SHALL NOT perform I/O.

#### Scenario: setStatus records an event
- **WHEN** `fake.setStatus("PVTI_1", "Ready")` is called after seeding item `PVTI_1`
- **THEN** `fake.events` ends with `{kind: "setStatus", args: {itemId: "PVTI_1", status: "Ready"}}`
- **AND** `await fake.getItem("PVTI_1")` reflects the new status

#### Scenario: upsertComment deduplicates by marker
- **WHEN** `fake.upsertComment(1, "m", "v1")` then `fake.upsertComment(1, "m", "v2")` are called
- **THEN** the seeded issue has exactly one comment whose body starts with `<!-- night-shift:marker=m -->` and ends with `v2`

### Requirement: GitHub config schema and secret handling

`NightShiftConfigSchema` SHALL be extended with a `github` section: `appId: number`, `installationId: number`, one of `privateKey: string` or `privateKeyPath: string`, `webhookSecret: string`, `owner: string`, `repo: string`, `projectNodeId: string`, optional `statusFieldName: string` (default `"Status"`), optional `manageStatusOptions: boolean` (default `true`). `privateKeyPath` SHALL be resolved relative to the config file's directory. Secrets SHALL be loadable via `.env` and interpolated into the config at load time.

#### Scenario: Exactly one of privateKey/privateKeyPath is required
- **WHEN** a config provides neither or both
- **THEN** `NightShiftConfigSchema.parse` throws

#### Scenario: Default statusFieldName
- **WHEN** a config omits `github.statusFieldName`
- **THEN** the parsed value has `statusFieldName: "Status"`

#### Scenario: manageStatusOptions defaults to true
- **WHEN** a config omits `github.manageStatusOptions`
- **THEN** the parsed value has `manageStatusOptions: true`

### Requirement: Module boundary for src/github/

`src/github/**` SHALL import only from: `zod`, `@octokit/core`, `@octokit/rest`, `@octokit/graphql`, `@octokit/webhooks`, `@octokit/auth-app`, `node:crypto`, `node:fs/promises`, `node:path`, `node:timers/promises`, `src/contracts/**`, and its own siblings. `src/github/**` SHALL NOT import from `src/adapters/**`, `src/config/**`, or any phase module.

#### Scenario: Boundary lint passes on the shipped module
- **WHEN** `npm run lint:boundaries` runs
- **THEN** `src/github/**` produces no violations

#### Scenario: A disallowed import is caught
- **GIVEN** a hypothetical `src/github/foo.ts` that imports from `src/config/schema.js`
- **WHEN** `npm run lint:boundaries` runs
- **THEN** the script exits non-zero and names the violation

### Requirement: listComments exposes issue comment history

The `GitHubClient` SHALL expose `listComments(issueNumber: number): Promise<Comment[]>` returning every comment on the given issue in chronological (ascending) order. Each `Comment` SHALL carry at least `id: number` and `body: string`. The method SHALL paginate through all pages. This surface enables the specify phase to feed operator replies back into the specifier prompt after a `Blocked` round-trip.

#### Scenario: Empty issue returns an empty array
- **GIVEN** an issue with no comments
- **WHEN** `client.listComments(issueNumber)` is called
- **THEN** the resolved value is `[]`

#### Scenario: Paginated history is concatenated in order
- **GIVEN** an issue with 150 comments across two pages
- **WHEN** `listComments` is called
- **THEN** the returned array has length 150 and its order matches GitHub's created-ascending order

#### Scenario: In-memory fake returns seeded comments
- **GIVEN** a fake client seeded with two comment bodies for issue #42
- **WHEN** `listComments(42)` is called
- **THEN** both bodies appear in the result in insertion order

### Requirement: pushBranch pushes a local commit to the remote

The `GitHubClient` SHALL expose `pushBranch(branch: string, sha: string): Promise<void>`. The method SHALL push the local branch's current HEAD (on the caller's git worktree) to `refs/heads/<branch>` on the configured remote. When the remote rejects the push as non-fast-forward, the method SHALL throw `GitHubPushRejectedError` (a typed error extending the existing `GitHubError` hierarchy) with the rejection reason attached.

#### Scenario: Successful push updates the remote ref
- **GIVEN** a local commit `abc1234` on branch `night-shift/t-1-slug`
- **WHEN** `pushBranch("night-shift/t-1-slug", "abc1234")` is called
- **THEN** the remote branch ref now points at `abc1234`

#### Scenario: Non-fast-forward rejection is typed
- **GIVEN** a branch whose remote head has diverged from the local head
- **WHEN** `pushBranch` is called
- **THEN** a `GitHubPushRejectedError` is thrown and no subsequent mutation is emitted

#### Scenario: In-memory fake records the push
- **WHEN** `pushBranch(branch, sha)` is called on `InMemoryFakeGitHubClient`
- **THEN** the fake's branch store records `{ branch, sha }` and a later `listPushes()` helper returns that entry

### Requirement: upsertPullRequest is idempotent by branch

The `GitHubClient` SHALL expose `upsertPullRequest({ branch, baseBranch, title, body }): Promise<PRRef>`. When no open PR exists for `branch → baseBranch`, the method SHALL create one. When one already exists, the method SHALL update its `title` and `body` in place and return the same `PRRef`. The method SHALL NOT create duplicate PRs for the same `branch → baseBranch` pair.

#### Scenario: First call creates a PR
- **GIVEN** a branch with no open PR
- **WHEN** `upsertPullRequest({ branch, baseBranch, title, body })` is called
- **THEN** a new PR is opened and the returned `PRRef.number` is positive

#### Scenario: Second call updates the same PR
- **GIVEN** a branch with an open PR `#42`
- **WHEN** `upsertPullRequest` is called again with a different `body`
- **THEN** no new PR is created and the returned `PRRef.number` is `42`
- **AND** the PR body on the remote matches the new value

#### Scenario: Fake preserves idempotency
- **WHEN** `upsertPullRequest` is called twice on `InMemoryFakeGitHubClient` with the same `branch`
- **THEN** the fake's PR store has exactly one entry for that branch

### Requirement: getPullRequestDiff returns a unified diff

The `GitHubClient` SHALL expose `getPullRequestDiff(pullNumber: number): Promise<string>` returning the PR's unified diff as produced by GitHub's `application/vnd.github.v3.diff` media type. The returned string SHALL be the raw diff body.

#### Scenario: Returns a non-empty diff for a PR with changes
- **GIVEN** a PR that modifies two files
- **WHEN** `getPullRequestDiff(pr.number)` is called
- **THEN** the returned string contains `diff --git` headers for each changed file

#### Scenario: Fake returns the seeded diff
- **GIVEN** `InMemoryFakeGitHubClient` seeded with a diff body for PR `#42`
- **WHEN** `getPullRequestDiff(42)` is called
- **THEN** the resolved value equals the seeded body

### Requirement: listChangedFiles returns a path + additions + deletions breakdown

The `GitHubClient` SHALL expose `listChangedFiles(pullNumber: number): Promise<ChangedFile[]>` where `ChangedFile` has at least `{ path: string, additions: number, deletions: number, status: "added" | "modified" | "removed" | "renamed" }`. The method SHALL paginate through all changed files.

#### Scenario: Paginated changes are concatenated
- **GIVEN** a PR with 120 changed files across two pages
- **WHEN** `listChangedFiles` is called
- **THEN** the returned array has length 120

#### Scenario: Fake round-trips seeded files
- **GIVEN** the fake seeded with three `ChangedFile` entries for PR `#42`
- **WHEN** `listChangedFiles(42)` is called
- **THEN** the resolved value has three entries with matching fields

### Requirement: listReviewComments returns review-line comments

The `GitHubClient` SHALL expose `listReviewComments(pullNumber: number): Promise<ReviewComment[]>` where `ReviewComment` carries at least `{ id: number, body: string, path: string, line: number | null }`. The method SHALL paginate through all pages and return comments in ascending creation order.

#### Scenario: Empty PR returns an empty array
- **GIVEN** a PR with no review comments
- **WHEN** `listReviewComments(pr.number)` is called
- **THEN** the resolved value is `[]`

### Requirement: upsertReviewComment is idempotent by marker + path + line

The `GitHubClient` SHALL expose `upsertReviewComment(pullNumber, markerId, { path, line, body })`. When no existing review comment on the given `path` and `line` whose body starts with the Night-Shift marker for `markerId` exists, the method SHALL create one. When one exists, the method SHALL update its body in place. The method SHALL NOT create duplicate comments for the same `(markerId, path, line)` triple.

#### Scenario: First call creates a line comment
- **GIVEN** a PR with no Night-Shift review comments
- **WHEN** `upsertReviewComment(pr.number, "review:finding", { path: "src/a.ts", line: 10, body: "x" })` is called
- **THEN** a new line comment is created whose body starts with the Night-Shift marker for `review:finding`

#### Scenario: Second call updates the same comment
- **GIVEN** a prior call already created a `review:finding` comment at `src/a.ts:10`
- **WHEN** the method is called again with a different `body`
- **THEN** no new comment is created and the existing comment's body matches the new value

#### Scenario: Same marker on a different line creates a new comment
- **GIVEN** an existing `review:finding` comment at `src/a.ts:10`
- **WHEN** `upsertReviewComment` is called for the same marker at `src/a.ts:42`
- **THEN** a new review comment is created and the existing one at line 10 is unchanged

### Requirement: createReview submits a top-level PR review

The `GitHubClient` SHALL expose `createReview(pullNumber, { event, body }): Promise<{ id: number }>` where `event` is one of `"APPROVE" | "REQUEST_CHANGES" | "COMMENT"`. The method SHALL create a new top-level review with the given body and event.

#### Scenario: Approve review is submitted
- **WHEN** `createReview(pr.number, { event: "APPROVE", body: "ok" })` is called
- **THEN** the PR has a new review of event `APPROVE` with body `"ok"`

#### Scenario: Unsupported event is rejected
- **WHEN** `createReview(pr.number, { event: "DISMISS", body: "x" })` is called
- **THEN** a validation error is thrown before any request is sent

### Requirement: listReviews and updateReview support marker-keyed updates

The `GitHubClient` SHALL expose `listReviews(pullNumber): Promise<Review[]>` where `Review` carries at least `{ id: number, body: string, state: string, authorAssociation: string }`, and `updateReview(pullNumber, reviewId, { body }): Promise<void>` which updates the body of an existing review. These surfaces enable the review phase to avoid duplicate top-level reviews by looking up an existing Night-Shift-marker-keyed review and updating it in place.

#### Scenario: listReviews returns prior reviews
- **GIVEN** a PR with two prior reviews
- **WHEN** `listReviews(pr.number)` is called
- **THEN** the resolved value has length 2

#### Scenario: updateReview changes the body
- **GIVEN** a review `#7` with body `"old"`
- **WHEN** `updateReview(pr.number, 7, { body: "new" })` is called
- **THEN** the review's body on the remote equals `"new"`
