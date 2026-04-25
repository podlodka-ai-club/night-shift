## Why

The Temporal UI shows workflow status but lacks visibility into what the workflow is _currently doing_ — which phase is active, what gate it's blocked on, how many review iterations have passed, and accumulated cost. Operators must query the workflow or read logs to understand progress. `setCurrentDetails()` renders live Markdown on the workflow overview page, giving operators an at-a-glance dashboard without external tooling.

## What Changes

- Call `setCurrentDetails()` at every state transition inside `ticketWorkflow` to render a compact Markdown dashboard
- Dashboard shows: current phase, blocked reason (if any), review iteration count, cost rollup, and a timeline of completed phases
- No new dependencies, APIs, or breaking changes — this is additive workflow-internal behaviour

## Capabilities

### New Capabilities
- `workflow-dashboard`: Live Markdown dashboard rendered via `setCurrentDetails()` in the Temporal UI, updated at every workflow state transition

### Modified Capabilities
- `orchestration-runtime`: The workflow function gains `setCurrentDetails()` calls and a `renderDashboard()` helper; tests verify the details string is set at each transition

## Impact

- `src/orchestration/workflow.ts` — new import (`setCurrentDetails` from `@temporalio/workflow`), new `renderDashboard()` helper, calls at each state transition
- `src/orchestration/__test__/workflow.test.ts` — mock `setCurrentDetails`, assert dashboard content at key checkpoints
- No dependency changes (API already in `@temporalio/workflow`)
