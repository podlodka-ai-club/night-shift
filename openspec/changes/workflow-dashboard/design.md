## Context

`ticketWorkflow` in `src/orchestration/workflow.ts` currently tracks `blockedReason` via a query handler but provides no visual summary in the Temporal UI. The `@temporalio/workflow` package exposes `setCurrentDetails(markdown: string)` which renders Markdown on the workflow overview page in real time.

The workflow already maintains all the state needed for a dashboard: current phase, blocked reason, review iteration, and cost rollup.

## Goals / Non-Goals

**Goals:**
- Render a live Markdown dashboard via `setCurrentDetails()` at every state transition
- Show: current phase, status (running/blocked/done), blocked reason, review iteration, cost rollup, and a timeline of completed phases with durations
- Stream live agent activity details (tool calls, message summaries, token usage) from activities into the dashboard via a Temporal signal
- Keep the dashboard compact (fits in the Temporal UI overview pane without scrolling)
- Test that `setCurrentDetails` is called with expected content at key transitions

**Non-Goals:**
- External dashboard or separate UI
- Persisting dashboard history (Temporal already records event history)
- Custom Temporal search attributes
- Full message text streaming (only summaries and tool-use events)

## Decisions

### 1. Single `renderDashboard()` helper inside workflow.ts

A pure function that takes the current workflow state and returns a Markdown string. Called after every state mutation (phase start, phase complete, gate enter, gate exit, review iteration).

**Why:** Keeps rendering co-located with the workflow. No new files needed for this small feature. The function is deterministic (no side effects beyond the Temporal API call).

**Alternatives considered:**
- Separate `dashboard.ts` module — over-engineered for a single helper function
- Template string inline at each call site — duplicates formatting logic

### 2. Dashboard layout

```markdown
## 🎫 ticket-42 — my-change

**Phase:** ⏳ Specify → Implement → Review
**Status:** 🔴 Blocked — awaiting_spec_review
**Review:** iteration 0/2
**Cost:** $0.00 (0 tokens)

### Timeline
| Phase | Duration | Result |
|-------|----------|--------|
| Specify | 2m 14s | ✅ refined |
| Implement | — | ⏳ running |
```

Uses emoji for scanability. The phase pipeline shows all three phases with the active one marked. The timeline table grows as phases complete.

### 3. State tracking additions

Add a `phases` timeline array to the workflow state tracking start/end timestamps and outcomes. This data is already partially available but needs to be captured explicitly for the dashboard.

```ts
interface PhaseEntry {
  name: "specify" | "implement" | "review";
  startedAt: number;  // Date.now() — deterministic in Temporal replay
  finishedAt?: number;
  result?: string;
  iteration?: number;
}
```

**Note:** Use Temporal's deterministic `Date.now()` which is safe in replay.

### 4. Mock `setCurrentDetails` in tests

Add `setCurrentDetails` to the existing `@temporalio/workflow` mock in workflow.test.ts. Assert it was called at key checkpoints (phase transitions, gate entry/exit) with expected substrings rather than exact matches to avoid brittle tests.

### 5. Live agent activity progress via signal

Activities run phase runners that emit `AgentStreamEvent`s (tool-use, message-completed, turn-completed, etc.). To surface this in the Temporal UI dashboard, activities collect these events into a compact Markdown snippet and signal the workflow periodically.

**Mechanism:**

```
Activity (specifyActivity, implementActivity, reviewActivity)
  │
  ├─ Wraps the phase runner's EventSink with a batching observer
  ├─ On each AgentStreamEvent:
  │   ├─ Appends to an internal log (capped at last N entries)
  │   └─ If ≥2s since last signal OR event is tool-use/turn-completed:
  │       └─ Formats log → Markdown → signals workflow via parentWorkflow handle
  │
  └─ Workflow signal handler: activityProgress(md: string)
      └─ Stores md in `activityDetail` state variable
      └─ Calls updateDashboard() which renders activityDetail below the phase info
```

**Why signal instead of heartbeat details?**
- Heartbeat details are only visible via API query, not in the Temporal UI overview page
- `setCurrentDetails()` is a workflow-only API — the activity cannot call it directly
- Signals deliver the data into the workflow's deterministic state, making it visible via `setCurrentDetails()`

**Why not one signal per event?**
- Agent sessions can emit hundreds of events (text deltas, tool calls). One signal per event would flood the Temporal event history and slow replays.
- Batching at 2s intervals or tool-use boundaries gives real-time feel without signal spam. The activity keeps a rolling window of the last 10 formatted lines and signals at most once per 2s.

**Compact Markdown format (Codex-inspired):**

```markdown
### 🤖 Specify — running

⚡ shell `npm run typecheck` → ✅ (2.1s)
⚡ file-change `src/config/schema.ts`
💬 "Added temporal config defaults..."
📊 Turn 3 — 1,204 tokens ($0.02)
```

Each line is one log entry:
- `⚡ <source> \`<tool>\`` for tool-use events, with `→ ✅/❌ (duration)` on tool-result
- `💬 "<truncated first 60 chars>..."` for message-completed
- `📊 Turn N — X tokens ($Y)` for turn-completed

**Activity-side implementation:**

A new `ActivityProgressReporter` class in `src/orchestration/activity-progress.ts`:
- Constructor receives the parent workflow handle (obtained via `Context.current().info.workflowExecution` in the activity)
- `push(event: AgentStreamEvent)` — appends formatted line to rolling buffer, conditionally signals
- `flush()` — sends final signal (called when activity finishes)
- Buffer is capped at 10 lines (older lines evicted) to keep Markdown under size limit
- Minimum interval between signals: 2 seconds
- Immediate signal on: `tool-use`, `turn-completed`, `turn-failed`

**Workflow-side:**

- New signal: `activityProgress` accepting a single `string` argument (the formatted Markdown)
- Signal handler stores the string in `activityDetail: string` state variable
- `renderDashboard()` appends `activityDetail` below the phase/status section when non-empty
- `activityDetail` is cleared when a phase completes (so stale output from specify doesn't show during implement)

### 6. Dashboard layout (updated)

```markdown
## 🎫 ticket-42 — my-change

**Phase:** ⏳ Specify → Implement → Review
**Status:** 🟢 Running
**Cost:** $0.02 (1,204 tokens)

### 🤖 Specify — running

⚡ shell `npm run typecheck` → ✅ (2.1s)
⚡ file-change `src/config/schema.ts`
💬 "Added temporal config defaults..."
📊 Turn 3 — 1,204 tokens ($0.02)

### Timeline
| Phase | Duration | Result |
|-------|----------|--------|
```

The activity detail section appears between the status header and the timeline table. It shows the last ~10 events from the currently running activity. When the activity completes, it is replaced by a timeline row.

## Risks / Trade-offs

- **Payload size**: `setCurrentDetails` has no documented limit but extremely large strings could impact Temporal server performance → keep dashboard under 4 KiB (activity detail capped at 10 lines ≈ 800 bytes; header + timeline ≈ 500 bytes)
- **Replay safety**: `Date.now()` in Temporal workflows returns deterministic replay-safe values, but `renderDashboard()` must remain a pure function of workflow state (no external calls) → mitigated by design
- **Signal volume**: Batching at 2s intervals limits signal count. A 15-minute activity generates at most ~450 signals. Temporal handles this comfortably, but the 2s floor prevents accidental flooding.
- **Signal replay overhead**: Each `activityProgress` signal is replayed. With the 2s batching, a typical workflow generates 50-100 progress signals total → acceptable for replay performance.
- **Test brittleness**: Asserting exact Markdown output is fragile → test with `toContain()` / regex for key sections rather than snapshot matching
- **Lost signals on activity failure**: If an activity crashes mid-stream, the last few events may not be signaled. Acceptable — the workflow will show the last successfully received progress.
