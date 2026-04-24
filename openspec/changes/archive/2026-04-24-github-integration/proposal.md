## Why

Night Shift's baseline flow is ticket-driven: a GitHub Projects v2 board is the single source of truth for work-in-flight. Before any phase (`specify`, `implement`, `review`) can run, the orchestrator needs a typed, testable way to observe ticket state, transition it, and reflect progress (branches, PRs, comments, labels, escalations) back into the board. Without this layer, every phase re-implements the same REST/GraphQL glue and becomes hard to fake in tests.

This change also unlocks webhook-driven orchestration: the runtime in change #7 listens for `project_v2_item` and `issues` events, and the phases' output events (from `phase-contracts`) are turned into visible progress via this module.

## What Changes

- New `src/github/` module exposing a **pure, session-based `GitHubClient` interface** that encapsulates every read/write the phases need. No direct Octokit imports outside this module.
- Typed **GraphQL client for Projects v2**: list items, read the configured status field, transition an item to a named status, read custom fields on items.
- **Status option resolution at client build time**: map the 7 documented status names (`Backlog`, `Refinement`, `Refined`, `Ready`, `In progress`, `In review`, `Ready to merge`) to Projects v2 single-select option IDs; **auto-create** any missing options via GraphQL mutation (idempotent).
- **Issue/PR REST operations**: fetch issue, create branch (`night-shift/<ticket-slug>` — already defined in `phase-contracts`), open PR, upsert comment (by marker), add/remove labels, set PR draft/ready, request review. Missing labels auto-created on first use.
- **Webhook handler library**: a pure function `handleWebhook({headers, body}) → ParsedWebhookEvent` that (a) verifies `X-Hub-Signature-256` against a configured secret (constant-time compare), (b) rejects unknown event types without throwing on the transport, (c) returns a discriminated union of the event kinds Night Shift cares about. **No HTTP server is shipped** — callers (the orchestration runtime, smee/ngrok locally, a Fastify server in prod) wire it into their own transport.
- **Authentication via GitHub App**: installation token acquisition using the App ID + private key; tokens cached and refreshed before expiry. PAT path is NOT included.
- **Retry/rate-limit policy**: exponential backoff with jitter on 5xx, secondary rate limit errors, and `retry-after`/`x-ratelimit-reset` responses. Cap at 5 attempts. Primary rate limit (quota exhausted) surfaces immediately with a typed error.
- **`InMemoryFakeGitHubClient`** implementing the same interface for phase tests; scripted issues, labels, project items, and an in-memory event log.
- New module boundary rule enforced by `lint:boundaries`: `src/github/**` may only import from `src/contracts/**`, `zod`, `@octokit/*`, `@octokit/graphql`, `@octokit/webhooks`, `@octokit/auth-app`, node built-ins (`node:crypto`, `node:timers/promises`), and siblings.
- New factory `createGitHubClient(config)` that validates credentials, resolves the project's status-field option IDs, and returns a ready-to-use client.
- Example config extended (`night-shift.config.example.ts`) to show the `github` section: App ID, private key path, webhook secret, owner/repo, project node ID.

## Capabilities

### New Capabilities
- `github-integration`: typed GitHub App + Projects v2 + webhooks client used by every phase and by the orchestration runtime.

### Modified Capabilities
<!-- None. `phase-contracts` already defines Ticket and branch naming; this change consumes them without altering them. -->

## Impact

- **Code**: new `src/github/` module (client interface, GraphQL client, REST client, webhook parser, fake, factory, errors); additions to `src/config/schema.ts` for a `github` config section; updated `scripts/check-boundaries.mjs`; example config updates.
- **Dependencies**: `@octokit/core`, `@octokit/graphql`, `@octokit/rest`, `@octokit/webhooks`, `@octokit/auth-app`. Dev: `nock` (or `msw`) for network-level integration tests.
- **Config**: `NightShiftConfigSchema` gains `github: { appId, privateKey | privateKeyPath, installationId, webhookSecret, owner, repo, projectNodeId, statusFieldName? }`. Secrets via `.env` as documented in `openspec/config.yaml`.
- **Operational**: an App install must exist on the target org/repo with perms: `issues:write`, `pull_requests:write`, `contents:write`, `metadata:read`, `project:write`. Documented in `src/github/README.md`.
- **Downstream changes** (`specify-phase`, `implement-phase`, `review-phase`, `orchestration-runtime`) depend on this client; all receive the same typed interface and can be tested against the in-memory fake.
- **Does NOT include**: an HTTP server, CLI wiring, Temporal signals/activities (those belong in `orchestration-runtime`), polling fallback (deferred until a concrete no-ingress scenario is prioritised).
