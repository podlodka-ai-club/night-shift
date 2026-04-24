## ADDED Requirements

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
