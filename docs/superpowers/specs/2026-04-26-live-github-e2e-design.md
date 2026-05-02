# Live GitHub E2E design

## Goal

Add a dedicated top-level `e2e/` module that exercises the real orchestrator workflow against live GitHub state.

The E2E run should:
- create a real GitHub issue in a configured repo
- add that issue to the configured GitHub Project
- run the real Temporal workflow against that issue
- verify that the workflow creates a pull request, comments on the issue, and moves the project item through statuses
- clean up created artifacts by default, while preserving failures for debugging

## Primary goals

- keep the E2E harness separate from `orchestrator/`
- reuse the real orchestrator workflow and activity code rather than reimplementing it
- support `real` and `fake` agent modes via environment variable
- make the E2E run self-contained by starting its own Temporal runtime if possible
- verify status progression, not just final state

## Non-goals

- replacing the existing unit/integration tests in `orchestrator/src/mocha`
- making `npm test` run live GitHub E2E by default
- introducing a CI-ready always-on live test in this pass
- requiring the GitHub Project view id for workflow execution

## Design choice

Use a dedicated top-level `e2e/` package with an **in-process Temporal harness**.

The harness should:
- spin up its own local Temporal test server
- create a worker against that server
- reuse the real orchestrator workflow definitions and activity factories
- inject either the real or fake agent runtime depending on environment

This is preferred over spawning the production worker/client entrypoints because it is easier to control, easier to keep deterministic in fake mode, and does not require bending `orchestrator/src/worker.ts` into an E2E-specific shape.

## Target architecture

### 1. Separate top-level package

Add a new top-level `e2e/` module next to `orchestrator/`.

Likely contents:
- `e2e/package.json`
- `e2e/src/config.ts`
- `e2e/src/github-seed.ts`
- `e2e/src/agent-mode.ts`
- `e2e/src/status-poller.ts`
- `e2e/src/verify.ts`
- `e2e/src/cleanup.ts`
- `e2e/src/run-e2e.ts`

The package should have its own explicit run command and should not be wired into `orchestrator`'s default test script.

### 2. Reuse the real orchestrator workflow

The E2E worker should execute the real workflow implementation from `orchestrator/src/workflows.ts` and use the real activity factory from `orchestrator/src/activities.ts`.

The design target is:
- real workflow code
- real GitHub activities
- real worktree/git behavior
- configurable agent implementation

The E2E harness should not duplicate workflow logic in its own package.

### 3. Self-contained Temporal runtime

The E2E harness should start its own Temporal runtime if possible by using the same local test-server approach already used by repository workflow tests.

That means the E2E run owns:
- Temporal server lifecycle
- worker lifecycle
- workflow execution lifecycle

This keeps the run reproducible and avoids depending on an already-running developer environment.

## Agent mode design

### 1. `E2E_AGENT_MODE=real`

In `real` mode, the worker should use the current real orchestrator agent behavior.

Expected prerequisites:
- GitHub token
- any required Codex/model/provider credentials

Verification in this mode should be looser because model output may vary.

### 2. `E2E_AGENT_MODE=fake`

In `fake` mode, the workflow should still be real, but the agent runtime should be replaced with a deterministic implementation.

The fake agent should:
- write a deterministic file change into the issue worktree
- return deterministic structured metadata for commit message, PR title, and PR body

This produces a real commit, branch, push, and pull request while avoiding model nondeterminism and external model cost.

### 3. Override boundary

The override should be narrow.

Only the agent runtime should change between `real` and `fake` modes. GitHub, worktree, workflow, and Temporal execution should remain real.

## Configuration surface

Recommended environment variables:

- `E2E_TARGET_REPO`
  - repository where the issue is created and the PR is expected
- `E2E_PROJECT_OWNER`
  - GitHub Project owner
- `E2E_PROJECT_NUMBER`
  - GitHub Project number
- `E2E_AGENT_MODE`
  - `real` or `fake`
- `E2E_CLEANUP`
  - `true` or `false`, default `true`
- `E2E_PRESERVE_ON_FAILURE`
  - `true` or `false`, default `true`
- `GITHUB_TOKEN` or `GH_TOKEN`
  - GitHub auth

The `/views/<id>` part of the provided GitHub Project URL is useful for human navigation but is not required as a workflow input. The workflow operates on the project owner/number and status names.

## Verification design

### 1. Seed a uniquely identifiable issue

The E2E harness should create the issue with a unique run identifier embedded in the title and body.

That marker should be used later to:
- find the created issue
- distinguish its comment from pre-existing comments
- tie the created PR back to the E2E run

### 2. Verify status progression by observation

Final state alone is insufficient to prove the project item moved through the intended statuses.

The E2E harness should:
- place the issue into `Ready`
- poll the GitHub Project item status while the workflow runs
- record the observed sequence of statuses

Success should require evidence of:
- `Ready`
- `In progress`
- final `In review`

The design does not depend on server-side status-history APIs; polling observed state is sufficient.

### 3. Verify PR creation and metadata

In `fake` mode, verify strictly:
- exact commit message
- exact PR title
- exact PR body
- deterministic file content or file path marker

In `real` mode, verify more loosely:
- metadata is structurally valid
- PR is tied to the seeded issue/run marker
- PR targets the configured repository
- PR body/title contain the required issue linkage or run marker

### 4. Verify the issue comment

The issue should contain a new comment that references the created PR URL.

The harness should verify that the comment belongs to the current run, ideally by matching the run marker and PR URL together.

## Cleanup design

Default behavior:
- `E2E_CLEANUP=true`
- `E2E_PRESERVE_ON_FAILURE=true`

Meaning:
- successful runs should attempt cleanup automatically
- failed runs should preserve artifacts by default for inspection

Cleanup should be best-effort and may include:
- closing the pull request
- closing the issue
- removing the project item if appropriate
- deleting the remote branch if safe and clearly attributable to the run

Cleanup failures should be reported in the final run summary but should not erase the primary verification result.

## Reporting

The E2E harness should emit a final structured summary including:
- run id
- issue URL
- PR URL
- observed status sequence
- verification pass/fail details
- cleanup actions attempted
- cleanup leftovers, if any

This makes the run debuggable without reading raw worker logs.

## Likely file impact

New package/files:
- `e2e/package.json`
- `e2e/src/*`

Likely orchestrator touchpoints:
- `orchestrator/src/activities.ts`
- `orchestrator/src/activity-deps.ts`
- possibly a small export or helper to let the E2E harness assemble real runtimes with a configurable agent runtime

## Constraints

- do not make the live E2E run part of the default `npm test`
- keep the agent override boundary narrow and explicit
- avoid coupling the E2E harness to `Context.current` or other ambient globals
- preserve the current production workflow behavior
- make cleanup safe-by-default but observable when it fails

## Expected outcome

After this work:
- developers can run a dedicated live E2E flow from `e2e/`
- the run can use either a real or deterministic fake agent
- the test verifies not just the final PR but the end-to-end GitHub lifecycle around the issue
- the live test remains isolated from the normal fast local test suite