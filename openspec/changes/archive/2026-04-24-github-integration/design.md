## Context

Night Shift drives work on a GitHub Projects v2 board. Every phase reads a `Ticket` (whose `source` is already modelled as `{kind: "github", projectNodeId, projectItemId, repoOwner, repoName, issueNumber}` by `phase-contracts`) and needs to (a) read the current status, (b) move the item forward on success/failure, (c) reflect progress in the issue (comments, labels), and (d) open/update the PR. Webhooks from `project_v2_item` and `issues` are the primary trigger for the orchestration runtime.

Octokit is the obvious client library: it has a first-class GraphQL client, a REST client, webhook verification helpers, and a GitHub App auth strategy. We wrap all of these behind one interface so phases remain provider-agnostic and trivial to unit-test with an in-memory fake.

The previous changes (`phase-contracts`, `agent-adapter-api`) established the module conventions this one follows: Zod at boundaries, integer micro-USD nowhere needed here, pure events, an in-memory fake for tests, a boundary-linter rule, and an `OpenSessionOptions`-style validated construction step.

## Goals / Non-Goals

**Goals:**
- One typed `GitHubClient` interface covering every read/write a phase or the runtime performs against GitHub.
- Safe, idempotent writes: status moves, comment upsert, label add/remove, PR create/update.
- Webhook signature verification and parsing as a pure function — no HTTP server.
- GitHub App authentication with automatic installation-token refresh.
- Deterministic `InMemoryFakeGitHubClient` that phase-level tests can script.
- Resilience: exponential backoff with jitter for transient failures and secondary rate limits; bounded at 5 attempts.
- Clear, typed errors so callers can distinguish "not found", "rate limited", "auth", "transient", "permission", and "bad input".

**Non-Goals:**
- An HTTP server or CLI for webhook delivery — the runtime change (#7) owns transport.
- Polling fallback for no-ingress environments — deferred.
- Supporting multiple project boards concurrently in one client — single project per client; open multiple clients if needed.
- PAT auth path — GitHub App only (private keys live in config/env).
- Octokit plugin customisation (throttling, retry plugins) — we implement retry ourselves so behavior is testable and boundary-friendly.
- Server-side GraphQL persisted queries or schema codegen — queries are handwritten TypeScript template literals; types defined locally.
- Re-verifying webhook signatures in the phases or runtime — the pure `handleWebhook` does that once at the edge.

## Decisions

### D1. One `GitHubClient` interface, multiple sub-modules

```ts
interface GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly projectNodeId: string;
  readonly statusOptionIds: Readonly<Record<StatusName, string>>; // resolved at build time

  // Project item / status
  getItem(itemId: string): Promise<ProjectItem>;
  getItemByIssue(issueNumber: number): Promise<ProjectItem | null>;
  setStatus(itemId: string, status: StatusName): Promise<void>;

  // Issue / PR
  getIssue(issueNumber: number): Promise<Issue>;
  createBranch(branch: string, fromRef?: string): Promise<{ ref: string; sha: string }>;
  upsertComment(issueNumber: number, markerId: string, body: string): Promise<{ commentId: number }>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  openPullRequest(input: OpenPROpts): Promise<PRRef>;
  setPullRequestReady(pullNumber: number, ready: boolean): Promise<void>;
}
```

**Rationale**: Phases consume a single surface; testing is one fake; the concrete implementation composes several small modules (`projects.ts`, `issues.ts`, `prs.ts`, `labels.ts`) internally without leaking that structure.

**Alternative considered**: separate `ProjectsClient` and `IssuesClient` surfaces. Rejected — phases always need both, and splitting just pushes the coordination elsewhere.

### D2. Factory `createGitHubClient(config)` does I/O up front

On construction we:
1. Build an `Octokit` instance with the App auth strategy (installation token).
2. Execute a startup GraphQL query against the configured project to:
   - Find the status single-select field (name configurable, defaults to `Status`).
   - List its options and build `statusOptionIds`.
   - Auto-create any of the 7 required options that are missing via `updateProjectV2SingleSelectField` (idempotent; we include the full option list that should exist and the mutation leaves existing options intact).
3. Return a frozen `GitHubClient`.

This violates the "no I/O in constructor" convention we've used elsewhere, but the factory function is explicitly asynchronous (`createGitHubClient` returns `Promise<GitHubClient>`), so we preserve the invariant "class constructors do no I/O" while acknowledging the startup cost. Callers can also opt out by injecting a pre-resolved `statusOptionIds` via `overrides`.

**Alternative considered**: lazy resolution on first status move. Rejected — a misconfigured board (wrong project ID, missing perms) should fail loudly at startup, not on the first ticket transition.

### D3. Auto-create missing status options

User confirmed preference. Implementation: single `updateProjectV2SingleSelectFieldOptions`-equivalent mutation runs only if at least one required option is absent. We pass the union of existing options + new ones to avoid deleting user additions. If any option already exists with the same name but is `archived`, we log a warning and treat it as present. Colors for auto-created options follow a fixed palette (`Backlog=GRAY`, `Refinement=BLUE`, `Refined=BLUE`, `Ready=GREEN`, `In progress=YELLOW`, `In review=PURPLE`, `Ready to merge=GREEN`).

### D4. Webhook handler is pure

```ts
handleWebhook({
  headers,
  rawBody,   // Buffer | string — required for signature verification
  secret,
}): ParsedWebhookEvent

type ParsedWebhookEvent =
  | { kind: "project_v2_item.changed"; itemId: string; previousStatus?: StatusName; currentStatus?: StatusName; projectNodeId: string; raw: unknown }
  | { kind: "issues.opened" | "issues.edited" | "issues.labeled" | "issues.closed"; issueNumber: number; repoOwner: string; repoName: string; raw: unknown }
  | { kind: "ignored"; reason: string }
```

Signature verification uses `crypto.timingSafeEqual` on `sha256=<hex>` computed over the raw body. Missing or mismatched signature throws `WebhookSignatureError` (caller turns into HTTP 401). Unknown `X-GitHub-Event` returns `{kind: "ignored", reason}` rather than throwing — the caller returns HTTP 202 and moves on.

**Alternative considered**: wrap Octokit's `@octokit/webhooks` handler directly. Rejected — their model is emitter-based with registered handlers, which does not compose well with our pure-function design nor with Temporal signals.

### D5. Retries and rate limiting

We wrap every outgoing REST/GraphQL call with a retry policy:

- Retry on: 5xx, network errors, and secondary rate limit (`403` with `message` containing "secondary rate limit" OR `x-ratelimit-remaining: 0` with `x-ratelimit-resource: abuse`).
- Respect `retry-after` (seconds) and `x-ratelimit-reset` (epoch seconds) when present; otherwise use exponential backoff `min(2^attempt * 250ms, 30s)` with `±25%` jitter.
- Max 5 attempts (4 retries).
- Primary rate limit (`x-ratelimit-remaining: 0` with reset in the future) throws `GitHubRateLimitError` immediately — caller decides whether to queue or surface.
- 4xx (except 403 secondary) throws `GitHubApiError` with status, code, and request URL.

**Alternative considered**: `@octokit/plugin-retry` + `@octokit/plugin-throttling`. Rejected for now — adds two dependencies and pulls config indirection. Can revisit after real-world usage if our implementation proves insufficient.

### D6. Error hierarchy

```ts
class GitHubError extends Error { readonly code: string; readonly cause?: unknown; }
class GitHubAuthError extends GitHubError { code = "auth"; }         // 401, token issues
class GitHubPermissionError extends GitHubError { code = "forbidden"; } // 403 non-rate-limit
class GitHubNotFoundError extends GitHubError { code = "not_found"; } // 404
class GitHubRateLimitError extends GitHubError { code = "rate_limit"; resetAt: Date; }
class GitHubTransientError extends GitHubError { code = "transient"; attempts: number; }
class GitHubApiError extends GitHubError { code = "api"; status: number; }
class WebhookSignatureError extends GitHubError { code = "webhook_signature"; }
class ConfigError extends GitHubError { code = "config"; }
```

All thrown errors extend `GitHubError` so callers can `instanceof GitHubError` once. Typed `code` enables structured logging and Temporal activity classification in #7.

### D7. Comment upsert via marker

Night Shift writes progress/escalation comments on issues. To avoid duplicates across retries and re-runs, every comment body begins with an HTML marker:

```
<!-- night-shift:marker=<markerId> -->
```

`upsertComment(issueNumber, markerId, body)` lists issue comments, finds the one with that marker, and updates it if present; creates it otherwise. Marker IDs are phase-meaningful (e.g., `specify:open-questions`, `implement:qa-report`, `review:escalation`).

### D8. GitHub App key material

Config accepts either `privateKey` (PEM string) or `privateKeyPath` (filesystem path resolved relative to the config file's directory). The loader resolves to an absolute path, reads the PEM, and passes it to `@octokit/auth-app`. Private keys are redacted from any error message via a known-substring filter before being thrown; test coverage enforces this.

### D9. In-memory fake

`InMemoryFakeGitHubClient` stores:
- A map of `projectItemId → {status, issueNumber}`
- A map of `issueNumber → Issue` (with `labels`, `comments[]`)
- A list of `PR`s keyed by `headRef`
- A map of `statusOptionIds` (preset with the 7 standard options)

Every mutating method returns a resolved promise and emits into an inspectable `events` array (`"setStatus" | "addLabels" | ...`). The fake also exposes helpers `seedIssue(...)`, `seedProjectItem(...)`, and a `handleFakeWebhook(event)` that returns the same `ParsedWebhookEvent` shape tests can assert against.

### D10. Module layout and boundary

```
src/github/
  index.ts            // public surface + createGitHubClient
  types.ts            // Zod schemas: GitHubConfigSchema, StatusName, ProjectItem, Issue, PRRef...
  errors.ts           // GitHubError hierarchy
  client.ts           // GitHubClient interface + concrete impl wiring sub-modules
  projects.ts         // Projects v2 GraphQL: getItem, setStatus, field resolution
  issues.ts           // getIssue, addLabels, removeLabel, upsertComment, ensureLabel
  prs.ts              // openPullRequest, setPullRequestReady, createBranch
  webhooks.ts         // handleWebhook (pure) + signature verification
  retry.ts            // retryable() wrapper + error classification
  fake.ts             // InMemoryFakeGitHubClient
  README.md
```

Boundary rule (added to `scripts/check-boundaries.mjs`):
- `src/github/**` may import only: `zod`, `@octokit/core`, `@octokit/rest`, `@octokit/graphql`, `@octokit/webhooks` (constants/types, not the emitter if we can avoid it), `@octokit/auth-app`, `node:crypto`, `node:fs/promises`, `node:path`, `node:timers/promises`, `src/contracts/**`, and siblings.

### D11. Testing strategy

- Unit tests per sub-module against a hand-rolled mock Octokit (plain object exposing `.request`, `.graphql`). No network.
- Retry tests inject a fake clock (`fakeTimers` in Vitest) and assert attempt counts and backoff bounds.
- Webhook tests run real HMAC signatures against a fixed body and secret.
- Integration tests against a local `nock` scope for the concrete `createGitHubClient` → factory resolves status options and exposes a working client. Networkless.
- Fake adapter has its own test suite verifying the event log ordering.

## Risks / Trade-offs

- **[Risk] GitHub App auth requires extra user setup** (create app, install it, generate key). → Mitigation: clear README with screenshots (docs task); `ConfigError` with remediation hint when config incomplete; example config populated.
- **[Risk] Auto-creating status options could surprise a user with a customised board.** → Mitigation: a `config.github.manageStatusOptions` boolean (default `true`); when `false`, missing options throw `ConfigError` at startup with the list of missing names and an instruction to create them manually.
- **[Risk] Secondary rate limits can stall progress in a concurrent run.** → Mitigation: jittered backoff and a low concurrency cap (one in-flight request per client, enforced via a tiny internal mutex); orchestration-runtime owns higher-level concurrency.
- **[Risk] Webhook deliveries can be duplicated by GitHub.** → Mitigation: we expose the delivery ID (`X-GitHub-Delivery`) on `ParsedWebhookEvent`; the runtime change uses Temporal idempotency keys. Not this change's problem, but surfaced.
- **[Risk] Private-key handling is the highest-sensitivity surface.** → Mitigation: keys loaded only via `privateKeyPath` resolved at load time, never logged (test coverage), never returned from any method.
- **[Trade-off] We handwrite retry logic instead of using Octokit plugins.** → Cost: we own the bugs. Benefit: no extra deps, testable with deterministic clock, behavior documented in one file.

## Open Questions

- **OQ1. Should `handleWebhook` also verify `X-Hub-Signature` (SHA-1)?** Decision: no — SHA-256 only. GitHub has signed with SHA-256 since 2019 and our webhook secret is new.
- **OQ2. Do we ship a request-level concurrency cap or leave it to the runtime?** Working decision: a per-client max-1 in-flight cap is added (simple mutex) to avoid secondary rate-limit cascades; the runtime can still fan out across many clients.
- **OQ3. How do we surface the App's installation ID?** Working decision: it's explicit in config (`installationId`). A helper `resolveInstallationId(appId, privateKey, owner, repo)` is exported but not required — advanced users can auto-discover.
- **OQ4. Where does the webhook secret rotation live?** Deferred. For M1 the secret is static; rotation is a runtime concern.
