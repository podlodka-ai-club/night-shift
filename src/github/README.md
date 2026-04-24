# `src/github/` — GitHub integration

Typed, testable wrappers around the GitHub REST and GraphQL APIs used by
Night Shift to drive Projects v2 state, issue comments, labels, branches,
and pull requests. Authentication is always via a GitHub App installation.

## Public surface

```ts
import {
  createGitHubClient,
  handleWebhook,
  createInMemoryFakeGitHubClient,
  GitHubError,
  WebhookSignatureError,
  StatusNameSchema,
  type GitHubClient,
  type ParsedWebhookEvent,
  type ChangedFile,
  type ReviewComment,
  type Review,
} from "./src/github";
```

- `createGitHubClient(config)` — async factory that validates config, loads
  the private key, resolves the project's Status field, auto-creates any
  missing canonical status options (opt-out via `manageStatusOptions: false`),
  and returns a frozen `GitHubClient`.
- `GitHubClient` — interface with every mutation serialised through an
  internal single-flight mutex so bursty writes don't trip secondary rate
  limits.
  - **PR review surfaces**: `getPullRequestDiff(pullNumber)`,
    `listChangedFiles(pullNumber)`, `listReviewComments(pullNumber)`,
    `upsertReviewComment(pullNumber, markerId, { path, line, body })`,
    `createReview(pullNumber, { event, body })`,
    `listReviews(pullNumber)`, `updateReview(pullNumber, reviewId, { body })`.
- `handleWebhook({ headers, rawBody, secret })` — pure function that verifies
  the `X-Hub-Signature-256` HMAC with `timingSafeEqual` and parses the body
  into a `ParsedWebhookEvent` discriminated union. It does **not** ship an
  HTTP server; mount it in your own transport.
- `createInMemoryFakeGitHubClient()` — in-memory double for tests. Exposes
  a public `events` log and seed helpers (`seedDiff`, `seedChangedFiles`,
  `seedReviewComment`, `seedReview`, `seedPr`).

## GitHub App setup

1. **Create the App** in your org (Settings → Developer settings → GitHub
   Apps → New GitHub App).
2. **Permissions** (repository):
   - Contents: Read & Write (for branch creation)
   - Issues: Read & Write (labels, comments, state)
   - Pull requests: Read & Write
   - Projects: Read & Write (organisation-level for Projects v2)
   - Metadata: Read (always required)
3. **Subscribe to events**: `issues`, `pull_request`, `projects_v2_item`.
4. **Generate a webhook secret** and store it in `GITHUB_WEBHOOK_SECRET`.
5. **Generate a private key** (PEM). Save it to a path outside the repo and
   point `privateKeyPath` at it, or inline the PEM in `privateKey` (never
   commit it).
6. **Install the App** on the target repo/org and copy the installation id.
7. Fill in the `github:` block in `night-shift.config.ts` (see
   `night-shift.config.example.ts`).

## Environment variables

The loader does not read these directly — pass them through your config
file — but these are the conventional names we recommend:

| Variable                   | Purpose                          |
| -------------------------- | -------------------------------- |
| `GITHUB_APP_ID`            | App numeric id                   |
| `GITHUB_INSTALLATION_ID`   | Installation id on the target org/repo |
| `GITHUB_PRIVATE_KEY_PATH`  | Absolute path to the PEM file    |
| `GITHUB_WEBHOOK_SECRET`    | Webhook shared secret            |
| `GITHUB_PROJECT_NODE_ID`   | Projects v2 GraphQL node id      |

## Error taxonomy

Every error extends `GitHubError` and carries a stable `code`:

- `GitHubAuthError` — 401 / bad credentials
- `GitHubPermissionError` — 403 (not rate limit)
- `GitHubNotFoundError` — 404
- `GitHubRateLimitError` — primary rate limit; `resetAt` included
- `GitHubTransientError` — exhausted retries; `attempts` included
- `GitHubApiError` — other 4xx / generic API failure
- `WebhookSignatureError` — missing or mismatched HMAC
- `ConfigError` — bad config or missing Projects v2 field/options

PEM blocks are stripped from any error message via `redactPem()`.

## Testing

Prefer `createInMemoryFakeGitHubClient()` for unit tests. For integration
tests against the real wire format, use `nock` to mock the REST/GraphQL
endpoints.
