# Task 12 Progress Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream assistant-authored intermediate progress into Temporal current details while preserving deterministic phase/final summaries and excluding raw tool-event noise.

**Architecture:** Keep `workflows.ts` as the single rendering surface, teach `activity-agent-sequence.ts` to extract bounded assistant-message summaries from provider events, and continue using existing phase-level summaries as the deterministic final state. Validate the seam with targeted Mocha tests first, then extend the fake-agent path so a live/fake run can surface the new UI behavior.

**Tech Stack:** TypeScript, Temporal workflows/activities, Mocha, existing fake-agent harness.

---

### Task 1: Add failing tests for assistant-message extraction and workflow rendering

**Files:**
- Modify: `orchestrator/src/mocha/activity-agent-sequence-runtime.test.ts`
- Modify: `orchestrator/src/mocha/workflow-shell.test.ts`

- [ ] Add a failing runtime test that feeds `provider-item` events shaped like assistant messages into a prompt turn and expects only assistant text to survive as progress output.
- [ ] Add a failing runtime test that proves tool-like provider items are ignored.
- [ ] Add a failing workflow-rendering test that expects current details to keep `Latest activity` plus a short recent-summary section.
- [ ] Run only the new targeted tests first and confirm they fail for the expected missing-behavior reason.

### Task 2: Implement bounded assistant-summary extraction in the agent activity path

**Files:**
- Modify: `orchestrator/src/activity-agent-sequence.ts`

- [ ] Add a narrow helper that inspects `AgentProgressEvent` values and returns assistant-authored text only for recognized provider message items.
- [ ] Thread that helper through prompt and structured turns so the activity emits progress updates while turns are running, without surfacing tool/usage noise.
- [ ] Keep the implementation conservative: trim empty text, dedupe repeats, and avoid changing checkpoint semantics.
- [ ] Re-run the targeted runtime tests and make them pass before moving on.

### Task 3: Extend workflow details rendering for recent summaries without regressing final summaries

**Files:**
- Modify: `orchestrator/src/workflows.ts`
- Modify: `orchestrator/src/mocha/workflow-shell.test.ts`

- [ ] Extend workflow shell state to retain the latest activity plus a bounded recent-summary history.
- [ ] Update the `activityProgressSignal` handler and phase-local `onProgress(...)` callbacks to flow through one shared helper that maintains the bounded list.
- [ ] Update `renderWorkflowCurrentDetails(...)` to render the recent-summary section only when present, while preserving existing phase/blocking/issue information.
- [ ] Re-run the focused workflow-shell tests and make them pass.

### Task 4: Verify docs and fake-agent path, then run repo-wide checks

**Files:**
- Modify: `e2e/src/fake-agent.ts`
- Modify: `e2e/src/fake-agent.test.ts`
- Modify: `orchestrator/README.md`

- [ ] Add minimal fake-agent assistant-message events so the fake path exercises the new extraction seam without introducing raw tool noise.
- [ ] Add/adjust fake-agent tests to cover those emitted events.
- [ ] Update README wording to explain that Temporal UI now shows assistant-authored intermediate summaries plus deterministic final phase summaries.
- [ ] Run the smallest useful validation first, then `make check`, then the fake-agent verification path required by Task 12.