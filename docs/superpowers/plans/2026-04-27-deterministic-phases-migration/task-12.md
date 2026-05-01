# Task 12 — Stream agent-authored progress summaries into Temporal UI

## Motivation

The current branch already writes workflow-facing Markdown into Temporal via `setCurrentDetails(...)`, but it does not provide donor-style live agent visibility. The donor branch streams rich activity progress into the workflow dashboard, yet that raw event model is noisier than desired here. This task adds a cleaner operator-facing observability slice: stream intermediate **Codex assistant-authored messages** plus require explicit **final summaries** at meaningful checkpoints, while keeping raw tool-use/tool-result noise out of the Temporal UI.

## References

- Current branch
  - `orchestrator/src/workflows.ts`
  - `orchestrator/src/activity-agent-sequence.ts`
  - `orchestrator/src/activity-agent-turn.ts`
  - `orchestrator/src/activity-deps.ts`
  - `orchestrator/src/phases/specify/phase.ts`
  - `orchestrator/src/phases/implement/phase.ts`
  - `orchestrator/src/phases/review/phase.ts`
- Architecture donor branch (`remotes/origin/milestone-1-deterministic-phases`)
  - `src/orchestration/workflow.ts`
  - `src/orchestration/activities.ts`
  - `src/orchestration/activity-progress.ts`
  - `src/orchestration/__test__/activities.test.ts`
  - `src/orchestration/__test__/workflow.test.ts`

## Execution Baseline

- Implementation base snapshot: current branch `0f39315b3c26f05df37400951cb215a700442636` (`0f39315`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- Tasks 1 through 11 are already complete; this task is an observability follow-up that should reuse the existing workflow-shell/current-details path instead of replacing it.
- The objective is not donor parity on raw telemetry volume. The objective is donor-like operator visibility with a cleaner summary-first UI.

## Prerequisites

- Task 3 complete and green, because the phased workflow shell and `setCurrentDetails(...)` dashboard path already exist and should remain the rendering surface.
- Task 11 complete and green, because scheduled pickup now makes background automation more autonomous and increases the value of live operator-visible progress summaries.

## Target Code State

- The current workflow shell continues to own Temporal UI rendering through `setCurrentDetails(...)`, but it can now surface live progress updates originating from agent execution rather than only phase-local static strings.
- Intermediate progress shown in Temporal UI comes from **Codex assistant-authored messages** (for example message-completed events), not from raw tool-use/tool-result events.
- Agent-driven checkpoints/phase completions produce explicit operator-facing summaries that are more deterministic than free-form streamed chatter alone.
- The UI excludes raw tool telemetry spam; it should show readable progress summaries, latest activity, and optionally a short recent-summary history instead of every tool invocation.
- A bounded silence/liveness fallback may update the UI when a long-running agent turn emits no assistant-authored summary for too long, but that fallback must remain minimal and must not become a second raw-event stream.
- Existing workflow-blocked, failure, and completion paths continue to publish clear final summaries in Temporal UI and must not regress.

## Acceptance Criteria (AC)

1. The workflow can receive and render intermediate progress updates derived from streamed **assistant-authored** Codex messages during agent execution.
2. Raw tool-use/tool-result events are not surfaced directly in Temporal UI; the rendered output stays summary-oriented and operator-readable.
3. Agent-driven steps or phase boundaries produce explicit final/operator-facing summaries so the workflow does not rely solely on incidental streamed assistant chatter for end-state visibility.
4. The workflow dashboard/current-details output preserves the existing phase/blocking/completion information while incorporating the new progress-summary surface.
5. If no assistant-authored summary is emitted for a long-running turn, any fallback update is bounded, low-noise, and clearly indicates liveness rather than pretending to be a semantic summary.
6. Tests cover message filtering (assistant messages in, tool telemetry out), workflow rendering updates, final summary behavior, and at least one long-running/no-summary fallback path if that fallback is implemented.
7. Documentation explains that Temporal UI now shows agent-authored intermediate summaries plus explicit final summaries, and that raw tool-event streaming remains intentionally out of scope.

## Definition of Done (DoD)

- Focused tests prove the workflow updates Temporal current details from assistant-authored progress messages without exposing raw tool spam.
- Focused tests prove final summaries remain available for blocked, failed, and successful phase outcomes.
- `make check` passes from the repository root.
- Documentation explains the new UI behavior and its intentionally summary-first scope.
- At least one fake-agent verification path exercises the new Temporal UI summary-updating behavior during a real workflow run, not only through isolated unit tests.

## Risks and Mitigations

- Risk: free-form assistant messages are too noisy or unreliable for operators.
  - Mitigation: treat assistant-authored messages as intermediate visibility only, and require explicit final/operator-facing summaries at checkpoint or phase boundaries.
- Risk: the implementation accidentally recreates donor-style raw event spam.
  - Mitigation: explicitly filter out tool-use/tool-result telemetry from the UI surface and test that only assistant-authored summaries are rendered.
- Risk: long agent turns produce no useful intermediate message, making the UI appear frozen.
  - Mitigation: allow a bounded low-noise liveness fallback that indicates the turn is still running without fabricating detailed semantic claims.
- Risk: adding richer progress output destabilizes the workflow-shell rendering contract.
  - Mitigation: keep `setCurrentDetails(...)` as the single rendering surface and evolve `renderWorkflowCurrentDetails(...)` conservatively with focused tests.