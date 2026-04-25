## Context

The implement phase already isolates ticket work in a dedicated git worktree,
but the specify phase still mutates the configured repo root directly. That
means branch checkout, prior-draft reads, spec file writes, commits, and
OpenSpec validation all depend on the main checkout being clean enough to
switch branches safely. The requested behavior is stricter: specify should
create the ticket branch from the configured base branch in a worktree, do all
spec work there, and close that worktree before implement later creates its
own fresh worktree.

## Goals / Non-Goals

**Goals:**
- Isolate specify from local uncommitted changes in the main checkout.
- Create the ticket branch from the configured base branch before the
  specifier writes any files.
- Run prior-draft reads, agent execution, file writes, git commit, and
  OpenSpec validation against the worktree path.
- Remove the specify worktree after terminal completion so implement can
  recreate a fresh worktree for the same branch.

**Non-Goals:**
- Reusing the specify worktree in implement.
- Changing the deterministic ticket-branch naming scheme.
- Changing spec review PR semantics, status transitions, or the implement
  phase's existing worktree contract.

## Decisions

### 1. Split branch preparation from worktree-local writes

Specify needs two git scopes:
- the repo-root git handle to ensure the base branch is available and create or
  reuse the ticket branch;
- a worktree-local git handle rooted at the created worktree path for file
  writes and commits.

This avoids mutating the main checkout after worktree creation while keeping
branch creation logic centralized.

**Alternatives considered:**
- Reusing the repo-root git handle for writes after creating the worktree:
  rejected because `writeTree` is rooted to the git handle's repo path and
  would still write into the main checkout.
- Extending `GitOps.writeTree` with an ad hoc cwd override: rejected because it
  pushes worktree concerns into the git abstraction rather than composing two
  already-valid git instances.

### 2. Add explicit worktree dependencies to specify

`runSpecifyPhase` should receive `WorktreeOps` plus a factory that can build a
`GitOps` instance for a scoped repo path. The CLI and worker already know how
to construct these dependencies for implement, so specify can reuse the same
composition pattern without teaching the phase about `simple-git` directly.

**Alternatives considered:**
- Letting the phase import `simple-git` directly: rejected because phase logic
  should stay dependency-injected and unit-testable.

### 3. Clean up the specifier worktree in a finally-style path

Once specify reaches a terminal outcome, the worktree no longer carries unique
state: the relevant state is on the ticket branch commit and in GitHub. The
phase should therefore remove the worktree after `refined` and `needs_input`
results, and also best-effort remove it when the phase throws after worktree
creation. That keeps the branch available while ensuring implement can create a
fresh worktree later without colliding with an existing checkout of the same
branch.

**Alternatives considered:**
- Keeping failed specifier worktrees for debugging, mirroring implement:
  rejected because the user requirement here prioritizes isolation and cleanup,
  and specifier state is less valuable once the branch and ticket comment exist.

## Risks / Trade-offs

- **More moving parts in specify wiring** → Reuse the implement pattern for
  `WorktreeOps` and scoped `GitOps` construction rather than inventing a new
  abstraction.
- **Cleanup can mask the on-disk state from a failing run** → Keep commits,
  pushed branches, and GitHub comments as the debugging surface; add focused
  tests so cleanup is predictable.
- **Branch ownership conflicts if another process already has the ticket branch
  checked out** → Removing the specifier worktree on completion minimizes the
  collision window and keeps implement's later `worktree.create` path viable.

## Migration Plan

1. Extend the specify-phase OpenSpec delta and tasks.
2. Update specify deps and CLI/worker wiring to provide worktree and scoped-git
   dependencies.
3. Refactor specify to create a worktree, reopen git inside it, run the phase
   body there, and always clean up the worktree afterward.
4. Add regression tests for branch creation from base, worktree-local writes,
   and cleanup on both terminal outcomes.
5. Validate with targeted tests and `openspec change validate --strict`.

## Open Questions

None.