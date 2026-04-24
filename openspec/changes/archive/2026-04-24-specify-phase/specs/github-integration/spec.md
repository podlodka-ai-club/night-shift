## ADDED Requirements

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

## MODIFIED Requirements

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
