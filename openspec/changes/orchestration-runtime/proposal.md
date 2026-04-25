## Why

Changes 1–6 delivered the three phases (Specify, Implement, Review) as
standalone CLI commands that a human must invoke in sequence, re-running
manually when a phase signals `needs_fix` or `escalate`. The system cannot
yet process a ticket end-to-end autonomously: there is no durable execution
engine that chains the phases, enforces the status state-machine, retries
transient failures, and drives the review → fix loop. Without this, Night
Shift cannot run unattended on its own repo — blocking the dogfooding goal.

## What Changes

- Add a **Temporal workflow** (`ticketWorkflow`) that takes a ticket through
  `Specify → Implement → Review`, automatically looping on `needs_fix` verdicts
  and escalating on `escalate` verdicts — honouring the max-iteration cap from
  phase-contracts.
- Add **Temporal activities** wrapping each phase runner (`runSpecifyPhase`,
  `runImplementPhase`, `runReviewPhase`) plus supporting GitHub operations
  (status transitions, polling for item re-entry after escalation).
- Add a **Temporal worker** process (`night-shift worker`) that registers the
  workflow and activities, connects to Temporal server, and runs until
  interrupted.
- Add a **workflow trigger CLI** (`night-shift start <projectItemId>`) that
  starts the workflow for a given ticket and prints the workflow run ID.
- Add a **webhook handler** that converts incoming `project_v2_item.changed`
  events into workflow start signals (status → Backlog triggers ticketWorkflow).
- Extend `NightShiftConfigSchema` with a `temporal` section (server URL,
  namespace, task queue).
- Emit structured **observability events** (workflow-level start/finish,
  per-phase delegation, cost/latency rollup) into the existing event contract.

## Capabilities

### New Capabilities
- `orchestration-runtime`: Temporal workflow, activities, worker process, trigger CLI, webhook-to-workflow bridge, and end-to-end observability for the ticket lifecycle.

### Modified Capabilities
- `github-integration`: Add a polling activity for detecting when an escalated item is moved back to `In review` by a human (re-entry detection for the escalation gate).

## Impact

- **New dependency:** `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity` added to `package.json`.
- **New module:** `src/orchestration/` containing workflow definitions, activity implementations, worker bootstrap, and the webhook bridge.
- **Config:** `NightShiftConfigSchema` gains a `temporal` sub-object (`serverUrl`, `namespace`, `taskQueue`).
- **CLI:** Two new commands — `night-shift worker` (long-running) and `night-shift start <itemId>` (one-shot).
- **Existing phase code:** No changes to phase internals; activities call the existing `run*Phase` functions.
- **Boundary rules:** `src/orchestration/` may import from `src/contracts/`, `src/config/`, `src/github/`, `src/adapters/`, and the three phase modules. Phase modules must NOT import from `src/orchestration/`.
