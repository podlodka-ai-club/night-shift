# Implementation plan: explicit activity dependency interfaces

## Objective

Execute the dependency-boundary cleanup in small safe steps, replacing the broad `ActivityDependencies` bag with explicit per-domain interfaces and improving test construction along the way.

## Phase 1 — define explicit interfaces

Create explicit dependency interfaces for the capabilities already present in the system.

Expected outputs:
- base infra interfaces such as command, filesystem, clock, GitHub client/auth, agent thread, and activity context
- explicit domain interfaces such as GitHub/worktree/agent activity deps

Rules:
- prefer explicit named interfaces over `Pick<>`
- do not change behavior in this phase
- keep existing helper implementations reusable where possible

## Phase 2 — retarget GitHub code first

Start with the smallest and clearest boundary.

Changes:
- make `activity-github-client.ts` depend on an explicit GitHub client/auth interface
- stop reading GitHub auth directly from `process.env` inside the GitHub client
- update GitHub activity modules to accept their explicit interfaces

Why first:
- smallest surface area
- easiest domain to validate directly with existing tests
- removes the ambient env dependency early

Verification:
- targeted `activity-github.test.ts`
- `npm run build`

## Phase 3 — retarget worktree code

Update worktree activities to depend on explicit filesystem/command/clock interfaces.

Changes:
- narrow helper signatures like `git(...)` and `pathExists(...)` if needed
- keep worktree logic behavior identical

Verification:
- targeted `activity-worktree.test.ts`
- `npm run build`

## Phase 4 — retarget agent runtime code

Update the agent activity path to use explicit agent/runtime/context interfaces.

Changes:
- separate command execution concerns from Codex thread concerns
- separate Temporal checkpoint/context concerns from generic runtime concerns
- keep checkpoint semantics and cancellation behavior unchanged

Verification:
- targeted agent sequence tests
- `npm run build`

## Phase 5 — simplify activity assembly

Once all domains use explicit interfaces, simplify the composition root.

Possible outcomes:
- `createActivities(...)` accepts separately named domain runtimes
- or one worker-only assembly object that is not exported as the conceptual dependency boundary

Decision rule:
- prefer the smallest change that keeps the composition root readable
- do not over-abstract if plain object wiring is already clear

## Phase 6 — fix the test rig pattern

Refactor `activity-test-helpers.ts` so tests stop mutating a shared runtime object.

Target pattern:
- each test asks for a fresh rig
- overrides are applied before activities are created
- no module-scoped mutable deps bag shared across test cases

Also clean up typing:
- remove permissive override typing that can hide misspelled dependency keys

Verification:
- targeted domain tests
- full `npm test`

## Phase 7 — optional file cohesion cleanup

If still warranted after the boundary refactor:
- split `activity-deps.ts` into smaller infra modules

Examples:
- command runtime helpers
- Codex runtime adapter
- Temporal activity-context adapter

This is optional because the primary goal is boundary clarity, not file splitting for its own sake.

## Risks to watch

- accidentally changing retry/checkpoint behavior in agent code
- drifting test helpers away from production wiring semantics
- introducing too many tiny abstractions that make assembly harder to read
- coupling the new explicit interfaces too tightly to temporary names

## Success criteria

- no module depends on the full broad `ActivityDependencies` bag unless it is truly a worker-only composition helper
- GitHub auth is injected explicitly
- activity tests construct fresh runtimes instead of mutating one shared object
- build and full test suite remain green

## Verification checklist

During implementation:
- run the smallest relevant test file after each phase
- run `npm run build` after each meaningful boundary change

At the end:
- `npm run build`
- `npm test`
- one focused reviewer pass on dependency boundaries and test construction