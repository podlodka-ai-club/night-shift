# Implementation plan: live GitHub E2E

## Objective

Add a dedicated top-level `e2e/` package that can run a live GitHub-backed end-to-end verification of the orchestrator workflow using either a real or deterministic fake agent.

The implementation should keep the live E2E path out of the default fast test suite while maximizing reuse of the real workflow and activity code.

## Phase 1 — package scaffolding and config parsing

Create the new `e2e/` package and establish a strict config boundary.

Expected outputs:
- `e2e/package.json`
- TypeScript entrypoint and package-local scripts
- `e2e/src/config.ts` with env parsing and validation

Configuration to support:
- `E2E_TARGET_REPO`
- `E2E_PROJECT_OWNER`
- `E2E_PROJECT_NUMBER`
- `E2E_AGENT_MODE`
- `E2E_CLEANUP`
- `E2E_PRESERVE_ON_FAILURE`
- GitHub token env lookup

Rules:
- booleans should use `true` / `false`
- fail fast on missing or malformed required config
- do not start any external side effects before config validation succeeds

Verification:
- add small focused config tests if the package has a local test harness
- otherwise validate via targeted script-level checks

## Phase 2 — GitHub seed and cleanup helpers

Add package-local helpers to create the seed issue and attach it to the configured GitHub Project in the `Ready` state.

Expected outputs:
- issue creation helper
- project-item insertion helper
- project status lookup helper
- cleanup helper for issue/PR/project/branch artifacts

Important design constraints:
- embed a unique run marker in seeded issue title/body
- make all created artifacts attributable to the current run
- keep cleanup best-effort and idempotent

Verification:
- unit-test any pure mapping/parsing helpers
- leave live GitHub verification to the final E2E flow

## Phase 3 — add the agent-mode override seam

Create the smallest explicit seam needed to reuse real orchestrator code while swapping only the agent runtime.

Likely changes:
- expose or add a helper that allows `e2e/` to assemble real GitHub/worktree runtimes with a configurable agent runtime
- keep GitHub/worktree/workflow behavior untouched
- add a deterministic fake agent implementation in `e2e/`

Fake-agent target behavior:
- write a deterministic file change into the live worktree
- return deterministic change metadata for commit message, PR title, and PR body

Decision rule:
- prefer a small explicit runtime-factory seam over ad-hoc monkeypatching or ambient global flags

Verification:
- targeted orchestrator tests for any new runtime-construction seam
- focused `e2e/` tests for fake-agent behavior where practical

## Phase 4 — Temporal harness and workflow runner

Build the `e2e/` runner that owns the Temporal runtime lifecycle.

Expected outputs:
- helper to start local Temporal test environment
- helper to create a worker against that environment
- helper to execute the real orchestrator workflow and await completion

Implementation target:
- reuse the same local Temporal test-server approach already used in repository workflow tests
- avoid requiring the production `worker.ts` CLI entrypoint to participate in the E2E flow

Verification:
- first get a minimal failing harness run in fake mode
- confirm the harness can boot worker + workflow locally before adding full GitHub assertions

## Phase 5 — runtime status polling and post-run verification

Add the verification layer that proves live GitHub side effects happened as intended.

Expected outputs:
- project-item status poller
- PR lookup and assertion helper
- issue comment assertion helper
- final run summary emitter

Verification rules:
- observed statuses must include `Ready`, `In progress`, and finish at `In review`
- in `fake` mode, assert exact PR metadata and deterministic file-change markers
- in `real` mode, assert structural validity plus required linkage/markers instead of exact text

Important detail:
- status progression must be proven by observed polling results, not only by final state

## Phase 6 — cleanup and failure reporting

Finalize cleanup behavior and ensure failures remain debuggable.

Expected outputs:
- success-path cleanup when `E2E_CLEANUP=true`
- preserve-on-failure behavior when `E2E_PRESERVE_ON_FAILURE=true`
- final summary that reports both verification result and cleanup leftovers

Rules:
- cleanup failure must not erase the primary test outcome
- preserve enough artifact information to debug failed runs quickly
- cleanup operations should tolerate partial progress and retries

## Phase 7 — package scripts, docs, and usability polish

Make the E2E package usable without reading implementation internals.

Expected outputs:
- explicit scripts such as a fake-mode run and a real-mode run
- short README or package-local usage section
- clear output telling the user what was created, verified, and cleaned up

Potential examples:
- `npm run e2e:fake`
- `npm run e2e:real`

Exact script names can be finalized during implementation.

## Dependency and packaging considerations

The new top-level package will likely need its own dependencies or devDependencies for:
- Temporal test environment/client/worker usage
- TypeScript runtime support
- optional local test runner support

Before adding or installing dependencies:
- identify the exact package set
- prefer reuse of versions already present in `orchestrator/` where sensible
- ask the user for explicit permission before running package-manager install commands

## Risks to watch

- accidentally widening the agent override seam into a broader test-only production hook
- relying on final GitHub state when the requirement is to prove intermediate status transitions
- leaving behind hard-to-find live GitHub artifacts on partial failures
- making the E2E package depend on ambient globals instead of explicit config/runtime injection
- over-coupling the E2E runner to current worker CLI details instead of real workflow/activity factories

## Success criteria

- there is a dedicated `e2e/` package outside `orchestrator/`
- the live E2E harness starts its own Temporal runtime locally
- the test can run in both `fake` and `real` agent modes
- the harness creates a real issue, observes status transitions, verifies PR/comment results, and reports cleanup
- the default fast orchestrator test suite remains unchanged and green

## Verification checklist

During implementation:
- get a small failing fake-mode check first
- run the smallest relevant tests after each meaningful change
- keep orchestrator verification scoped to files affected by any new runtime seam

At the end:
- targeted orchestrator tests for any touched runtime assembly code
- targeted `e2e/` tests for pure helpers
- one end-to-end `fake` mode run against live GitHub
- optionally one end-to-end `real` mode run when credentials are available and desired