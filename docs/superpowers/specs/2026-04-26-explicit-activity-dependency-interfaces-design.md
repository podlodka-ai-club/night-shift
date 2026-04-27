# Explicit activity dependency interfaces design

## Goal

Replace the broad `ActivityDependencies` bag with small explicit dependency interfaces per domain, without changing orchestrator behavior.

Primary goals:
- remove the “god object” pressure from `ActivityDependencies`
- make each module depend only on the capabilities it actually uses
- make tests construct fresh explicit runtimes instead of mutating a shared dependency bag
- keep the worker wiring simple and keep activity names/behavior stable

## Current problem

`orchestrator/src/activity-deps.ts` currently mixes unrelated concerns in one interface:

- HTTP transport
- filesystem access
- subprocess execution
- clock access
- Codex thread lifecycle
- Temporal heartbeat/checkpoint helpers

This causes three problems:

1. every activity module accepts more authority than it needs
2. `activity-deps.ts` is becoming an infrastructure catch-all file
3. tests partially recreate the old mutable runtime pattern by mutating one shared deps object after activity creation

## Design choice

Use **explicit domain interfaces**, not `Pick<ActivityDependencies, ...>` aliases.

Why:
- the boundary is clearer at the call site and in reviews
- modules stop conceptually depending on “a slice of the god object”
- the design can later evolve without keeping `ActivityDependencies` as the center of the system

`Pick<>` would be acceptable as a transitional trick, but it is not the target architecture.

## Target architecture

### 1. Keep one real composition root

The worker should still assemble real dependencies in one place.

Likely shape:
- `createGitHubRuntime()`
- `createWorktreeRuntime()`
- `createAgentRuntime()`
- `createActivities({ ... })`

Whether these are created independently or composed from a smaller shared infra factory is an implementation detail. The important part is that activity modules receive explicit interfaces.

### 2. Introduce explicit dependency interfaces by concern

Likely interfaces:

- `GitHubClientDeps`
  - `fetch`
  - `getGitHubToken`

- `CommandDeps`
  - `execFile`

- `FileSystemDeps`
  - `access`
  - `mkdir`
  - `appendFile`
  - `writeFile`

- `ClockDeps`
  - `now`

- `AgentThreadDeps`
  - `createCodexThread`
  - `resumeCodexThread`
  - `getCancellationSignal`

- `ActivityContextDeps`
  - `getHeartbeatDetails`
  - `heartbeat`

Then define domain-facing interfaces explicitly, for example:

- `GitHubActivityDeps`
  - built from `GitHubClientDeps`

- `WorktreeActivityDeps`
  - built from `FileSystemDeps`, `CommandDeps`, and `ClockDeps`

- `AgentActivityDeps`
  - built from `CommandDeps`, `FileSystemDeps`, `AgentThreadDeps`, and `ActivityContextDeps`

These can be written as standalone interfaces or as interface extension/composition. The key constraint is that the domain type names are explicit and intentional.

### 3. Move ambient GitHub auth into DI

GitHub auth should stop reading directly from `process.env` inside `activity-github-client.ts`.

Instead, inject a small explicit boundary such as:
- `getGitHubToken(): string`

This removes the current split between injected runtime and ambient environment.

### 4. Make tests create fresh runtimes

Tests should stop doing this pattern:
- create one deps object
- create activities once
- mutate deps later per test

Instead, test helpers should:
- create fresh explicit deps per test
- apply overrides before activity creation
- return fresh activities bound to those deps

This restores the main benefit of DI: behavior is fixed at construction time.

## File/module impact

Likely touched production files:
- `orchestrator/src/activity-deps.ts`
- `orchestrator/src/activities.ts`
- `orchestrator/src/activity-github-client.ts`
- `orchestrator/src/activity-github-project.ts`
- `orchestrator/src/activity-github-pull-request.ts`
- `orchestrator/src/activity-worktree.ts`
- `orchestrator/src/activity-agent-sequence.ts`
- `orchestrator/src/worker.ts`

Likely touched test files:
- `orchestrator/src/mocha/activity-test-helpers.ts`
- domain test files that currently rely on mutable shared runtime helpers

## Constraints

- no intentional workflow or activity behavior changes
- keep registered activity names stable
- preserve retry/cancellation/checkpoint semantics
- preserve current test coverage while changing the dependency boundary
- keep the worker composition root simple to understand

## Migration strategy

Do this incrementally:

1. define explicit interfaces first
2. retarget one domain at a time to the narrower interfaces
3. change tests to create fresh per-test runtimes
4. only then split `activity-deps.ts` further if it is still too broad

## Expected outcome

After this refactor:
- modules clearly advertise only the dependencies they need
- `ActivityDependencies` stops being the center of the architecture, or is reduced to an internal worker-composition detail
- tests become easier to reason about because they stop mutating shared runtime state
- future infra additions are less likely to bloat a single shared dependency bag