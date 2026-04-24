# `src/git/`

Minimal git surface used by phase code. We deliberately expose only the
operations the phases need so tests can swap in an in-memory fake.

## Interface

```ts
interface GitOps {
  checkoutBranch(branch: string): Promise<void>;
  writeTree(
    files: Array<{ path: string; content: string }>,
    commitMessage: string,
  ): Promise<{ sha: string }>;
  currentHeadSha(): Promise<string>;
}
```

## Implementations

- `createSimpleGitOps({ repoRoot, git })` — real impl backed by `simple-git`.
  Callers construct `simpleGit(repoRoot)` themselves to keep this module's
  import surface small.
- `createInMemoryFakeGitOps(initialBranch?)` — deterministic fake used by
  unit tests. Returns sha identifiers formatted as `sha<N>` padded to 40 hex
  chars (`sha10000…`), tracks committed files in memory, and records
  every commit in `.commits`.

## Example

```ts
const git = createInMemoryFakeGitOps();
await git.checkoutBranch("night-shift/TICKET-1");
const { sha } = await git.writeTree(
  [{ path: "a.txt", content: "hi" }],
  "first commit",
);
```
