## ADDED Requirements

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
