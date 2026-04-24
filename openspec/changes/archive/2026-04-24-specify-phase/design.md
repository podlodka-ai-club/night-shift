# Design: specify-phase

## Context

The Specify phase is the first of three M1 baseline phases (see
`openspec/project.md` → Baseline Flow). Its job is to turn a newly-filed
GitHub issue on a Projects v2 card into a machine-readable OpenSpec
change folder, committed on a deterministic branch, so the Implement
phase can later pick it up without re-reading the ticket.

The contracts already exist (`src/contracts/specify.ts` exports
`SpecifyInputSchema` + `SpecBundleSchema` + `validateSpecBundle`). The
agent adapter (`src/adapters/`) and GitHub client (`src/github/`) are both
shipped. This change composes them.

## Goals / Non-Goals

### Goals

- A single, testable `runSpecifyPhase(input, deps): Promise<SpecifyResult>`
  that is deterministic given its dependencies (no hidden I/O).
- All external effects — LLM call, GitHub mutations, git commits,
  filesystem writes, clock — are injected as deps so tests run in-memory.
- Every returned `SpecBundle` passes `validateSpecBundle(ticket, bundle)`
  and `openspec validate --strict`.
- Open questions round-trip to the ticket as a marker-keyed comment.

### Non-Goals

- Orchestration (retries, scheduling, restart safety) — belongs to #7.
- Parallel specifier implementations — out of scope for M1.
- Running the specifier inside a worktree — for now the phase writes the
  change folder directly into the current repo checkout. The Implement
  phase (#5) is responsible for worktrees.

## Decisions

### D1. Entry point shape

```ts
export interface SpecifyDeps {
  github: GitHubClient;
  agent: AgentAdapter;          // role-bound: the "specifier" role
  git: GitOps;
  fs: FsOps;                    // minimal: writeFile, mkdir, rm
  openspecCli: OpenSpecCli;     // runs `openspec validate` as a subprocess
  clock: () => Date;
  logger: StructuredLogger;     // emits Observability events
}

export type SpecifyResult =
  | { status: "refined"; bundle: SpecBundle }
  | { status: "needs_input"; openQuestions: string[]; assumptions: string[]; risks: string[] };

export async function runSpecifyPhase(
  input: { projectItemId: string },
  deps: SpecifyDeps,
): Promise<SpecifyResult>;
```

The caller (CLI or orchestrator) supplies a `projectItemId`, not a
pre-built `Ticket`. This keeps the phase authoritative about how a ticket
is fetched and means the CLI is a one-line wrapper.

### D2. GitOps and FsOps shapes

Minimal surfaces — just enough for tests to fake, not enough to leak
git internals into the phase:

```ts
export interface GitOps {
  checkoutBranch(branch: string): Promise<void>;
  writeTree(files: Map<string, string>, commitMessage: string): Promise<{ sha: string }>;
  currentHeadSha(): Promise<string>;
}
export interface FsOps {
  writeFile(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}
```

`writeTree` is an atomic "stage these files + commit" so the phase
doesn't need to think about git plumbing. The real implementation uses
`simple-git` (new dep); the fake records files + returns a deterministic
sha.

### D3. Fetching the ticket

The phase calls `GitHubClient.getItem(projectItemId)` first. If the item
has no `issueNumber`, it throws `SpecifyPhaseError("item has no linked
issue")` — the specifier has nothing to work with. Otherwise it calls
`getIssue(issueNumber)` and `listComments(issueNumber)` and builds a
`Ticket` using the helpers in `src/contracts/sources.ts`.

### D3a. Ticket comments are part of the prompt

The specifier prompt (see D6) renders every issue comment in
chronological order as part of the ticket context, **except** comments
authored by Night Shift itself (identified by our marker prefix
`<!-- night-shift:marker=… -->`). This covers both re-entry cases
described in D4: operator answers after `Blocked`, and reviewer
feedback after `Refined`. The phase itself does no diffing or
threading — it just passes all non-marker comments through. Because the
call flows through `deps.github`, unit tests can script comment history
directly on the in-memory fake.

### D3b. Prior change folder seeds the revision

If `openspec/changes/<name>/` already exists on the ticket branch when
the phase starts (e.g. after a reviewer moved a `Refined` ticket back
to `Backlog`), the phase reads its current contents through `deps.fs`
and appends them to the specifier prompt under a `## Current draft`
section. The specifier is instructed to **revise** the draft in light
of the new comments rather than rewrite from scratch. The existing
files are still overwritten wholesale by the `files[]` returned by
the specifier — the prior draft is context only, not a merge base.

### D4. Status transitions

1. Before the LLM call: if `item.status` is `Backlog`, transition to
   `Refinement`. If the item is already in `Refinement`, leave it — this
   makes the phase idempotent on crash recovery within a single run.
2. On success with no open questions: transition to `Refined`.
3. On `needs_input` (open questions OR validator errors after retry):
   transition to `Blocked`. The comment with the open questions is the
   operator's signal to act.
4. The phase never transitions into `Ready` or further, and never moves
   items out of `Refined`, `Ready`, `In progress`, `In review`,
   `Ready to merge`, or `Blocked` (it throws on entry instead).

Both `Blocked` and `Refined` are terminal states for the specify phase.
Re-entry is a human-gated loop in both cases:

- **Blocked → Backlog** — operator answers the open questions in a
  ticket comment, then manually moves the item back to `Backlog`.
- **Refined → Backlog** — reviewer leaves feedback comments on the
  ticket, then manually moves the item back to `Backlog` to request a
  revision.

In either case the orchestrator picks Backlog items up on its next
tick, which re-runs the phase through the normal `Backlog → Refinement`
pre-transition. On that re-run the new comments are already part of the
ticket context (see D3a), and the existing change folder — if any — is
fed back into the prompt as a revision base (see D3b). This keeps the
trigger explicit (the human's status move) and the phase itself
stateless — it does not diff comments or track prior runs.

Adding `Blocked` to `StatusName` is a small cross-cutting change to the
`github-integration` capability; it is captured as a MODIFIED delta in
this change's specs. `STATUS_COLORS` gets a `Blocked: "RED"` entry so
auto-created options are visually distinct in the GitHub UI.

### D5. Branch creation

The branch `branchNameFor(ticket)` is created before writing files. The
existing `GitHubClient.createBranch` is already idempotent when the
branch points at the same sha, so retries are safe. The fromRef is the
repo default branch (resolved server-side by `createBranch`).

### D6. Specifier prompt and structured response

The specifier receives a single `userMessage` containing the ticket
rendered as markdown and the response schema summarised in prose. The
phase invokes the adapter with `TurnOpts.outputSchema` set so the
provider produces a JSON object matching the schema (Codex adapter
already forwards `outputSchema`; providers that don't support structured
response formats fall back to prose and the phase parses + validates
post-hoc with the same Zod schema).

```ts
export const SpecifierResponseSchema = z.object({
  files: z
    .array(
      z.object({
        // Allowed paths relative to the change folder. The regex doubles
        // as the path-escape defence (no "..", no absolute paths).
        path: z
          .string()
          .regex(/^(proposal|design|tasks|specs\/[a-z0-9-]+\/spec)\.md$/),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .refine((fs) => fs.some((f) => f.path === "proposal.md"), {
      message: "proposal.md is required",
    })
    .refine((fs) => fs.some((f) => f.path === "tasks.md"), {
      message: "tasks.md is required",
    }),
  openQuestions: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});
export type SpecifierResponse = z.infer<typeof SpecifierResponseSchema>;
```

Parsing pipeline:

1. Take `TurnResult.finalText`.
2. `JSON.parse` it; on failure throw `SpecifyAgentError` with `code: "parse"`.
3. `SpecifierResponseSchema.parse`; on failure throw `SpecifyAgentError`
   with `code: "schema"` and the aggregated Zod issues in the message.
4. Hand the validated `files[]` to the writer.

Rationale (why JSON over a bespoke `<<<FILE>>>` delimiter):

- `JSON.parse` is robust; custom delimiter regex breaks when the model
  nests the marker, omits `<<<END>>>`, or emits backticks inside a block.
- Provider-enforced JSON mode makes malformed output a provider error,
  not our parse bug. Codex already honors `outputSchema` via the turn
  opts we defined in the adapter spec.
- The path regex replaces a separate path-escape check — one Zod pass
  covers framing, paths, and required-file coverage.
- Fixtures are plain JSON, so tests don't need a hand-written delimiter
  generator.

Markdown content lives inside `files[].content` as ordinary strings;
JSON escaping handles quotes and newlines, backticks pass through
untouched.

### D7. Validation + retry

After writing files, the phase shells out to `openspec validate <name>
--strict` via `openspecCli.validate(name)`. On failure, the phase:

1. Discards the written files (`fs.rm` of the change folder).
2. Re-runs the specifier with the validator error appended to the user
   message.
3. If the retry also fails, returns `status: "needs_input"` with the
   validator errors as open questions. No third attempt.

This bounds cost and latency. Repeated failures surface to the human on
the ticket as comments.

### D8. Commenting

On every terminal outcome the phase upserts a ticket comment with marker
`specify:summary` containing:

- A link to the change folder (`openspec/changes/<name>/`) on the ticket
  branch at the commit sha.
- The `openQuestions`, `assumptions`, `risks` lists.
- A footer with phase latency and token-usage (from the adapter's
  `Usage`). Useful for post-mortem.

### D9. Error taxonomy

- `SpecifyPhaseError` base + subclasses:
  - `SpecifyItemMissingError` — no issue linked to the project item.
  - `SpecifyAgentError` — adapter threw or returned unparsable output.
    Stable `code` values: `"parse"` (not valid JSON), `"schema"`
    (JSON but failed `SpecifierResponseSchema`), `"provider"` (adapter
    raised).
  - `SpecifyValidationError` — only thrown when the caller opts into
    strict mode (not by default); the default is to surface validator
    output via `needs_input`.
- All errors carry the `ticketId` (when known) and the elapsed latency.

### D10. Module layout

```
src/phases/specify/
  index.ts            # public: runSpecifyPhase + SpecifyResult + deps types
  phase.ts            # runSpecifyPhase implementation
  prompt.ts           # render ticket + parse response
  errors.ts           # SpecifyPhaseError hierarchy
  fake.ts             # test doubles for GitOps/FsOps/OpenSpecCli
  *.test.ts
src/git/
  index.ts            # GitOps interface + createSimpleGitOps
  fake.ts             # InMemoryFakeGitOps
src/cli/
  specify.ts          # `night-shift specify <itemId>`
  index.ts
```

`src/phases/**` is a new module boundary (enforced by
`scripts/check-boundaries.mjs`): may import `contracts`, `adapters`,
`github`, `git`, `config`, `zod`, `node:*`.

### D11. Testing

- Unit tests cover: response parsing (happy, malformed, path-escape),
  status-transition FSM, validator-retry loop, open-question short-circuit,
  branch-idempotency.
- An integration-style test wires `InMemoryFakeGitHubClient` +
  `InMemoryFakeAgentAdapter` + `InMemoryFakeGitOps` + real validator
  invocation against the real OpenSpec CLI and asserts:
  1. A valid spec bundle round-trips through `validateSpecBundle`.
  2. A bundle with a missing `## Purpose` section triggers a retry, the
     retry succeeds, and the final bundle is valid.
  3. A ticket with ambiguous body yields `needs_input` + a ticket
     comment with the marker.

## Risks / Trade-offs

- **LLM output parsing** is the most common failure mode. Mitigations:
  provider-enforced JSON mode via `outputSchema`, Zod validation of the
  full payload, automatic retry, and a hard failure surface
  (`needs_input`) rather than silent garbage.
- **Providers without JSON mode** fall back to a prose completion. The
  phase still runs `JSON.parse` + Zod post-hoc; on failure it retries
  with a stricter system prompt appended. Codex (the M1 default) does
  honor `outputSchema`.
- **Shelling out to `openspec`** adds a subprocess dep. We isolate it
  behind `OpenSpecCli` so the unit tests use a fake and only the
  integration test needs the real binary on `PATH`.
- **Committing directly on the default checkout** means a CLI run
  mutates the dev's working tree. Acceptable for M1 (Implement phase
  will introduce worktrees in #5); we log a loud warning if the working
  tree is dirty.
- **Open questions UX** — we use the marker comment pattern introduced
  by `github-integration`. If the specifier keeps asking the same
  questions on retry we stop after 2 phase runs (tracked outside this
  change by the orchestrator).

## Migration Plan

None — new capability. `specify-phase` composes existing contracts and
clients. No downstream consumers yet.
