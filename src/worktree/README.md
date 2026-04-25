# Worktree module

Minimal surface for creating and removing git worktrees so each ticket
can be implemented in isolation.

## `WorktreeOps`

```ts
interface WorktreeOps {
  create(opts: {
    ticketId: string;
    branch: string;
    fromRef?: string;
  }): Promise<{ path: string; branch: string }>;
  remove(worktreePath: string): Promise<void>;
}
```

## Implementations

- `createSimpleGitWorktreeOps({ repoRoot, git, worktreesRoot? })` —
  thin wrapper around `git worktree add` / `git worktree remove`.
  Worktrees live under a deterministic, filesystem-safe path below
  `<repoRoot>/.worktrees/` derived from `ticketId` by default.
- `createInMemoryFakeWorktreeOps({ rootDir? })` — materialises a real
  temp directory per ticket so tests that expect a path work without a
  git repo. Records every `create` / `remove` call on `events`.
