## ADDED Requirements

### Requirement: List project items by status

The `GitHubClient` interface SHALL expose a `listItemsByStatus(status: StatusName): Promise<ProjectItemSummary[]>` method that queries the Projects v2 GraphQL API for all items whose status field matches the given value. `ProjectItemSummary` SHALL contain `itemId` (project item node ID), `issueNumber`, `title`, `ticketId` (derived identically to `getItem().ticketId`, i.e. `<owner>/<repo>#<issueNumber>`), and `createdAt` (ISO 8601 timestamp of item creation). The method SHALL handle pagination for boards with more than 100 items. Results SHALL be ordered by `createdAt` ascending (oldest first).

#### Scenario: Returns matching items
- **WHEN** `listItemsByStatus("Backlog")` is called and the board has 2 items in Backlog
- **THEN** the method returns an array of 2 `ProjectItemSummary` objects with correct `itemId`, `issueNumber`, `title`, `ticketId`, and `createdAt`
- **AND** results are ordered by `createdAt` ascending

#### Scenario: No matching items returns empty array
- **WHEN** `listItemsByStatus("Backlog")` is called and no items have Backlog status
- **THEN** the method returns an empty array

#### Scenario: Pagination across large boards
- **WHEN** `listItemsByStatus("Backlog")` is called and the board has 150 items in Backlog
- **THEN** the method returns all 150 items by following GraphQL pagination cursors

#### Scenario: In-memory fake supports listItemsByStatus
- **WHEN** `listItemsByStatus` is called on `InMemoryFakeGitHubClient`
- **THEN** it returns items matching the requested status from the fake's internal store
