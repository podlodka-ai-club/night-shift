# Orchestrator activity refactor design

## Goal

Simplify the orchestrator codebase without changing workflow behavior.

Primary goals:
- reduce file size and mixed responsibilities
- make activity logic easier to read in isolation
- remove the mutable `activityRuntime` singleton
- reduce test duplication and setup complexity
- preserve existing behavior, activity names, and test semantics

## Problems in the current structure

### `orchestrator/src/activities.ts`

This file currently mixes:
- GitHub project lookup and API utilities
- local git/worktree lifecycle
- Codex SDK thread lifecycle
- agent sequence execution and checkpoint logic
- Temporal activity-context helpers
- generic command/runtime helpers

This makes the file hard to navigate and hard to reason about safely.

### `orchestrator/src/mocha/activities.test.ts`

This file mixes tests for unrelated domains:
- project lookup
- worktree/git behavior
- agent sequencing/checkpointing
- commit/push/PR behavior
- cleanup and helper behavior

It also relies heavily on shared global runtime patching, which increases coupling and duplication.

## Proposed architecture

### Dependency injection

Adopt Temporal's recommended activity DI pattern.

Introduce:
- `ActivityDependencies` interface
- `createActivityDependencies()` for real worker dependencies
- `createActivities(deps)` factory returning the activity implementations

Effects:
- activities receive explicit dependencies instead of importing a mutable runtime singleton
- worker registers `createActivities(createActivityDependencies())`
- tests can instantiate `createActivities(mockDeps)` directly

### Module boundaries

Production modules:
- `src/activities.ts` — thin public activity export surface / factory exports
- `src/activity-deps.ts` — dependency types and real dependency construction
- `src/activity-agent-sequence.ts` — Codex sequence, structured output, checkpoints, resume logic
- `src/activity-github.ts` — project lookup, REST/GraphQL helpers, issue comment/status logic
- `src/activity-worktree.ts` — clone/fetch/worktree/git/push/PR/cleanup logic

Optional small follow-up if clearly helpful:
- `src/workflow-agent-steps.ts` — workflow step construction helpers

### Tests

Split `src/mocha/activities.test.ts` into domain files:
- `activities-github.test.ts`
- `activities-worktree.test.ts`
- `activities-agent-sequence.test.ts`
- `activities-pr.test.ts`
- `activities-test-helpers.ts`

## Implementation strategy

1. Introduce DI types and factory shape.
2. Move runtime/context/command helpers behind injected dependencies.
3. Extract GitHub domain logic.
4. Extract worktree/git/PR domain logic.
5. Extract agent sequence/checkpoint logic.
6. Split tests by domain and move shared builders/mocks into helpers.
7. Do only small workflow cleanup if it clearly improves readability.

## Constraints

- no intentional behavior changes
- keep registered activity names stable
- keep workflow behavior stable
- preserve current retry/cancellation/checkpoint semantics
- preserve test coverage during the refactor

## Verification

During implementation:
- run targeted tests after each meaningful extraction

At the end:
- `npm run build`
- `npm test`
- optional final `review-code` pass focused on the refactor

## Expected outcome

After the refactor:
- `activities.ts` becomes a thin adapter instead of a monolith
- the main logic lives in smaller domain modules
- tests mirror production module boundaries
- dependency injection replaces global runtime patching
- the codebase is easier to read, review, and extend
