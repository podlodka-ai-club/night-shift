## Why

The specify phase currently operates directly inside the configured repo root.
That assumes the checkout is clean enough to switch branches and stage spec
files safely, which is brittle for unattended automation and risky when an
operator also has local edits in the same checkout. Implement already avoids
that class of interference by using a fresh worktree; specify should apply the
same isolation model.

## What Changes

- Change the specify phase to create the ticket branch from the configured base
  branch in a fresh worktree instead of mutating the main repo checkout.
- Run the specifier agent session, prior-draft reads, file writes, git commit,
  and OpenSpec validation inside the specifier worktree.
- Remove the specifier worktree on terminal completion so implement can create
  a fresh worktree for the same branch later.
- Preserve the existing branch/PR behavior: the ticket branch remains the same
  deterministic branch and is still pushed for spec review.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `specify-phase`: require the phase to isolate branch creation and spec file
  generation in a temporary worktree that is cleaned up after the phase
  completes.

## Impact

- **Phase runtime:** `src/phases/specify/**` will gain worktree lifecycle
  handling and use worktree-local git / filesystem operations.
- **CLI / worker wiring:** specify deps must provide `WorktreeOps` and a way to
  scope git operations to the created worktree path.
- **Tests:** specify-phase and worker/CLI tests will need coverage for worktree
  creation, cleanup, and worktree-local validation behavior.
- **Operational behavior:** the main repo checkout no longer needs to be clean
  for specify to run safely; implement continues to create its own fresh
  worktree later.