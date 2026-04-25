## ADDED Requirements

### Requirement: getItem resolves ticket and status from a project item ID

The `GitHubClient` SHALL expose `getItem(itemId: string): Promise<ProjectItem>` where `ProjectItem` carries at least `{ id: string, ticketId: string, status: StatusName, title: string, issueNumber: number }`. The method SHALL query the GitHub Projects v2 GraphQL API to resolve the item's content (issue) and current status field value. This surface enables the orchestration runtime to resolve a project-item ID into the ticket data needed to start a workflow.

#### Scenario: Returns a valid ProjectItem for a known item
- **GIVEN** a project item `PVTI_abc` linked to issue #42 with status `Backlog`
- **WHEN** `getItem("PVTI_abc")` is called
- **THEN** the returned value has `ticketId` matching the issue identifier, `status: "Backlog"`, and `issueNumber: 42`

#### Scenario: Unknown item throws GitHubNotFoundError
- **WHEN** `getItem("PVTI_nonexistent")` is called
- **THEN** a `GitHubNotFoundError` is thrown

#### Scenario: Fake returns seeded item
- **GIVEN** `InMemoryFakeGitHubClient` seeded with an item `PVTI_abc`
- **WHEN** `getItem("PVTI_abc")` is called
- **THEN** the resolved value matches the seeded data
