# Implement phase

Runs the Implement role on a GitHub Projects v2 item: reads the approved
spec bundle, asks the implementer agent for a patch, runs quality gates
in a worktree, and opens/updates a pull request.

## Dependencies

| Dep | Used for |
| --- | --- |
| `github: GitHubClient` | item + issue + comments, status transitions, branch push, PR upsert, summary comment |
| `git: GitOps` | checkout branch, write/commit files, compute diff against base |
| `fs: ImplementFs` | read spec-bundle from disk, write implementer files into the worktree |
| `worktree: WorktreeOps` | create a per-ticket worktree, remove on success |
| `gateRunner: QualityGateRunner` | run quality gates in the worktree cwd |
| `agent: AgentAdapter` | implementer session |

## CLI

```
night-shift implement --item <projectItemId> --change <change-name>
                      [--config <path>] [--repo-root <path>]
                      [--run-id <id>] [--profile <id>]
                      [--base-branch <branch>]
```

Exit codes: `0` pr_opened, `1` unexpected error, `2` needs_input, `64`
usage error.

## Test recipe

Unit tests drive the phase with `InMemoryFakeAdapter` (scripted turns),
`createInMemoryFakeGitHubClient`, `createInMemoryFakeGitOps`,
`createInMemoryFakeWorktreeOps`, and `createInMemoryFakeQualityGateRunner`.
See `phase.test.ts` for the canonical scaffolding.

## Debugging worktrees

On failure the phase intentionally leaves the worktree on disk. The
thrown `ImplementPhaseError` carries `worktreePath` so operators can
inspect the agent's work before retrying.
