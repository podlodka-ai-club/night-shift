# Implement Phase — Design

## Context

After `specify-phase` ships, the orchestrator has `Refined` tickets with
validated spec bundles on per-ticket branches. To turn them into PRs
that the review phase (and humans) can act on, we need a bounded,
testable phase that runs the implementer agent inside an isolated
working tree, enforces a configurable quality bar, and opens a pull
request. This change builds that middle step.

Like `specify-phase`, this module targets the same constraints:

- All I/O (git worktree, agent calls, GitHub mutations, quality-gate
  subprocesses) flows through injected deps so unit tests stay pure.
- A small, explicit error taxonomy so orchestration logic can route
  failures deterministically.
- Deterministic behaviour under retry: re-running on an already-in-progress
  ticket picks up where it left off rather than starting a second PR.

## Goals

1. `runImplementPhase(input, deps)` that takes `ImplementInput` and
   returns a discriminated `ImplementResult` (`pr_opened` | `needs_input`).
2. A worktree abstraction (`WorktreeOps`) with a real `simple-git`-based
   implementation and an in-memory fake.
3. A quality-gate runner (`QualityGateRunner`) driven by
   `NightShiftConfig.qualityGates`, with an in-memory fake.
4. CLI `night-shift implement <projectItemId>` matching `specify`'s
   exit-code contract.

## Non-Goals

- The reviewer phase (separate change).
- Temporal activities / signals (orchestration-runtime change).
- Automatic worktree TTL garbage collection (handled by the runtime).
- Complex git merge/rebase logic — we always push to the ticket branch
  and surface conflicts as `needs_input`.
- PR review comment management — that's the reviewer's job.

## Key Design Decisions

### D1. Entry and terminal transitions

1. On entry: require `item.status` to be `Ready` or `In progress`
   (crash-recovery idempotency). Any other status throws
   `ImplementPhaseError` with `code: "validation"` before any mutation.
2. If `Ready`, transition to `In progress` before touching the
   worktree. If already `In progress`, skip the transition.
3. On success (PR opened, all gates `passed`, spec-review clear):
   transition to `In review`.
4. On `needs_input` (quality-gate failures after retry, spec-review
   blocking issues after retry, or agent `parse`/`schema` error after
   retry): transition to `Blocked`. The operator resolves by pushing
   fixes or editing the spec, then moves the item back to `Ready`
   — the orchestrator re-triggers the phase exactly like the
   `specify-phase` Backlog reset.

### D2. Worktree isolation

`WorktreeOps` surface:

```ts
interface WorktreeOps {
  create(opts: { branch: string; ticketId: string }): Promise<{ path: string }>;
  remove(path: string): Promise<void>;
}
```

Real impl: `git worktree add .night-shift/worktrees/<ticketId> <branch>`.
Fake: returns a tmp dir created via `node:fs.mkdtemp`.

On success the phase calls `remove(path)`. On any thrown error the
worktree is **kept** and the path is included in the error payload so
operators can `cd` in. A TTL sweeper is out of scope — see the
orchestration-runtime change.

### D3. Deps shape

```ts
interface ImplementDeps {
  github: GitHubClient;              // extended: pushBranch, upsertPullRequest
  agent: AgentAdapter;               // roles: implementer, spec-reviewer
  git: GitOps;                       // from specify-phase
  worktree: WorktreeOps;             // new
  qualityGates: QualityGateRunner;   // new
  fs: FsOps;                         // reused from specify-phase
  clock: { now(): Date };
  logger: EventLogger;
  config: NightShiftConfig;
}
```

Every I/O dep is injectable for unit tests. Runtime assembly lives in
`src/cli/implement.ts` just like `specify`.

### D4. Implementer prompt and structured response

The implementer receives a single user message containing:

- Ticket title + body + labels.
- The four spec-bundle files (proposal/design/tasks/spec) rendered
  inline.
- The non-Night-Shift issue comments (same filter as `specify-phase`)
  so reviewer feedback on a re-run is visible.
- A prose summary of the response schema.

We force structured JSON via `TurnOpts.outputSchema`. Schema:

```ts
export const ImplementerResponseSchema = z.object({
  summary: z.string().min(1),
  filesWritten: z
    .array(
      z.object({
        // Repo-relative path with strict prefix allow-list; the worktree
        // is scoped to the ticket branch so this regex doubles as
        // path-escape defence.
        path: z.string().regex(/^[A-Za-z0-9._\/-]+$/).refine(
          (p) => !p.includes("..") && !p.startsWith("/"),
          { message: "absolute paths and parent traversal not allowed" },
        ),
        content: z.string(),
      }),
    )
    .min(1),
  selfReportedRisks: z.array(z.string()),
});
```

`parseResponse(finalText)` throws `ImplementAgentError` with `code:
"parse" | "schema"` on invalid output. On `schema` we retry once with
Zod errors appended to the next prompt (same pattern as
`specify-phase`).

### D5. Spec-review subagent

After the implementer writes files and before the quality gates run, a
second adapter session is opened with role `spec-reviewer`. The prompt
is:

- The diff vs the fork point of the ticket branch (obtained via
  `git.diffAgainstBase(baseBranch)` — a small addition to `GitOps`).
- The four spec-bundle files.

Structured response schema:

```ts
export const SpecReviewResponseSchema = z.object({
  subagentSummary: z.string().min(1),
  blockingIssues: z.array(z.string()),
});
```

Any non-empty `blockingIssues` triggers exactly one implementer retry
with the issues appended to its next prompt. After the retry we accept
whatever the implementer produced but surface remaining
`blockingIssues` in the `needs_input` payload.

### D6. Quality gates

Config shape (already present in `NightShiftConfig` but re-asserted
here for explicitness):

```ts
qualityGates: z.array(z.object({
  name: z.string().min(1),
  command: z.string().min(1),   // exact shell command, e.g. "npm run typecheck"
  cwd: z.string().optional(),   // defaults to the worktree root
})).default([
  { name: "typecheck", command: "npm run typecheck" },
  { name: "test",      command: "npm test --silent" },
  { name: "lint",      command: "npm run lint" },
]),
```

`QualityGateRunner.run(gate, { cwd })` returns `QualityGateResult` with
a 4 KiB `logsTail`. Timeouts, kill signal, and environment sanitation
are responsibilities of the runner. The phase executes gates
sequentially so a fast failure (typecheck) fails fast and we don't
waste tokens re-running the implementer after slow gates.

On failure, we run **one** implementer retry, passing the failed gate
name + `logsTail` in the next prompt. If gates still fail after retry,
we return `status: "needs_input"` with the failures listed as open
questions and transition the item to `Blocked`.

### D7. Commit, push, PR

1. The implementer's `filesWritten` are applied in the worktree via
   `deps.fs` (mkdirp + writeFile).
2. `deps.git.writeTree(files, commitMessage)` commits on the ticket
   branch (in the worktree) and returns the new HEAD sha.
3. `deps.github.pushBranch(branch, sha)` pushes.
4. `deps.github.upsertPullRequest({ branch, baseBranch, title, body })`
   opens a PR if one doesn't exist for that branch, otherwise updates
   the title + body. Response is the existing `PRRef` contract.

Idempotency is keyed entirely on branch name — retries re-use the PR.

### D8. Commenting

On every terminal path the phase upserts an `implement:summary` marker
comment on the ticket containing:

- Link to the PR (number + URL).
- The quality-gate result table.
- The spec-review `subagentSummary` and any remaining `blockingIssues`.
- The implementer's `selfReportedRisks`.
- Latency + aggregated token-usage footer.

### D9. Error taxonomy

All errors extend `ImplementPhaseError` with `code` values:

- `"validation"` — entry-status rejection, bad config.
- `"parse"` / `"schema"` / `"provider"` — agent failures (matches
  `specify-phase`).
- `"git"` — worktree/push failures.
- `"gate"` — only thrown when the caller opts into strict mode; the
  default is to surface gate failures via `needs_input`.
- `"io"` — filesystem failures.

All errors carry `ticketId`, `worktreePath` (when known), and
`latencyMs`. The worktree path is included so operators can inspect
state after failure.

### D10. Module layout

```
src/phases/implement/
  index.ts            # public: runImplementPhase + ImplementResult + deps types
  phase.ts            # orchestration
  prompt.ts           # renderers + parseResponse (implementer + spec-reviewer)
  errors.ts           # ImplementPhaseError hierarchy
  fake.ts             # test doubles for WorktreeOps/QualityGateRunner
  *.test.ts
src/worktree/
  index.ts            # WorktreeOps + createSimpleGitWorktreeOps
  fake.ts             # InMemoryFakeWorktreeOps
src/quality-gates/
  index.ts            # QualityGateRunner + createNodeQualityGateRunner
  fake.ts             # InMemoryFakeQualityGateRunner
src/cli/
  implement.ts        # `night-shift implement <itemId>`
```

Boundaries:

- `src/phases/implement/**` imports: `zod`, `node:*`, `src/contracts/**`,
  `src/adapters/**`, `src/github/**`, `src/git/**`, `src/worktree/**`,
  `src/quality-gates/**`, `src/config/**`.
- `src/worktree/**` and `src/quality-gates/**` import only `zod`,
  `node:*`, and `src/contracts/**`.
- `src/cli/implement.ts` imports `src/phases/implement/**` and the real
  factories.

### D11. Retry policy, concretely

One retry for each of:

- `ImplementerResponseSchema` parse/schema errors.
- Spec-review `blockingIssues` non-empty.
- Any quality-gate `failed` status.

That's a maximum of **3 implementer invocations** per phase run in the
worst case (schema-retry → spec-review retry → gate retry). We do NOT
combine retries: each is its own "one more try". The reviewer phase
owns the deeper fix loop.

## Risks & Mitigations

- **Runaway LLM token spend on flaky gates** — hard cap of one retry
  per failure mode; all gate logs truncated to 4 KiB before going back
  into the prompt; phase emits `phase.finished` with aggregate cost for
  the orchestrator to enforce budgets.
- **Worktree leaks on crash** — we document the keep-on-failure
  behaviour and rely on the orchestration runtime to sweep with a TTL.
  Unit tests assert that successful runs call `remove`.
- **Path escape in `filesWritten[].path`** — Zod regex + refinement
  blocks absolute paths and `..`; worktree scopes writes to the
  ticket's checkout anyway.
- **Duplicate PRs on retry** — `upsertPullRequest` is keyed on branch
  name; the implementation looks up existing PRs before creating.
- **Diverged ticket branch** — if `git push` rejects (non-fast-forward)
  we emit `code: "git"` and mark the item `Blocked`. Resolving the
  divergence is a human operation for M1.
