## 1. Specify worktree lifecycle

- [x] 1.1 Extend specify dependencies and CLI/worker wiring to provide `WorktreeOps` and scoped `GitOps` creation for a worktree path
- [x] 1.2 Update `runSpecifyPhase` to create the ticket branch from the configured base branch in a fresh worktree and run prior-draft reads, agent execution, file writes, and validation there
- [x] 1.3 Remove the specifier worktree on terminal completion and keep implement using its own later worktree creation path

## 2. Regression coverage

- [x] 2.1 Add specify-phase tests for first-run branch creation in a worktree, revision reuse of the ticket branch, and worktree cleanup on `refined`
- [x] 2.2 Add specify-phase coverage for worktree cleanup on `needs_input` and update any CLI/worker tests affected by the new specify deps

## 3. Validation

- [x] 3.1 Run focused Vitest coverage for specify-phase, worktree, and worker/CLI slices
- [x] 3.2 Run `openspec change validate specifier-worktree-isolation --strict` and mark the tasks complete