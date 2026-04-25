## 1. Dashboard state and helper

- [x] 1.1 Add `PhaseEntry` interface (`name`, `startedAt`, `finishedAt?`, `result?`, `iteration?`) and `phases: PhaseEntry[]` array to workflow state in `src/orchestration/workflow.ts`
- [x] 1.2 Add `renderDashboard()` pure function that takes `{ ticketId, changeName, currentPhase, blockedReason, reviewIteration, maxIterations, costRollup, phases }` and returns a Markdown string matching the design layout
- [x] 1.3 Add `formatDuration(ms: number): string` helper (e.g., `134000` → `"2m 14s"`)
- [x] 1.4 Import `setCurrentDetails` from `@temporalio/workflow`

## 2. Dashboard calls at state transitions

- [x] 2.1 Call `setCurrentDetails(renderDashboard(...))` at workflow start (before specify)
- [x] 2.2 Call after specify activity completes (add phase entry with result)
- [x] 2.3 Call on entering specify blocked gates (`awaiting_spec_review`, `specify_needs_input`)
- [x] 2.4 Call on exiting specify gates (before re-running or proceeding)
- [x] 2.5 Call after implement activity completes (add phase entry)
- [x] 2.6 Call on entering/exiting implement blocked gate (`implement_needs_input`)
- [x] 2.7 Call after each review activity completes (update phase entry with iteration)
- [x] 2.8 Call on entering/exiting review escalation gate (`review_escalation`)
- [x] 2.9 Call on workflow completion (final dashboard with all phases done)

## 3. Phase timeline tracking

- [x] 3.1 Record `startedAt = Date.now()` before each activity call
- [x] 3.2 Record `finishedAt = Date.now()` and `result` after each activity returns
- [x] 3.3 Track review iterations in phase entries

## 4. Tests

- [x] 4.1 Add `setCurrentDetails` to the `@temporalio/workflow` mock in `workflow.test.ts`
- [x] 4.2 Test: `renderDashboard()` returns Markdown containing ticket ID, change name, current phase, and status
- [x] 4.3 Test: `renderDashboard()` with blocked reason shows the reason in status line
- [x] 4.4 Test: `renderDashboard()` with completed phases shows timeline table with durations
- [x] 4.5 Test: `renderDashboard()` with review iteration shows "iteration N/M"
- [x] 4.6 Test: `formatDuration()` converts milliseconds to human-readable durations
- [x] 4.7 Test: happy path workflow calls `setCurrentDetails` at least at workflow start, after each phase, and at completion
- [x] 4.8 Test: blocked gate entry updates dashboard to show blocked status
- [x] 4.9 Test: rendered dashboard is under 2048 bytes for a full 3-phase workflow with 2 review iterations

## 5. Validation

- [x] 5.1 `npm run typecheck` passes
- [x] 5.2 `npm test` passes (all existing + new tests)
- [x] 5.3 `npm run lint:boundaries` passes

## 6. ActivityProgressReporter

- [ ] 6.1 Create `src/orchestration/activity-progress.ts` with `ActivityProgressReporter` class
- [ ] 6.2 Constructor accepts a `signalFn: (md: string) => Promise<void>` callback (injected by the activity to signal the parent workflow) and an optional `minIntervalMs` (default 2000)
- [ ] 6.3 `push(event: AgentStreamEvent)` — format event into a compact Markdown line and append to a rolling buffer (max 10 lines, FIFO eviction)
- [ ] 6.4 Format `tool-use` events as `⚡ <source> \`<tool>\``
- [ ] 6.5 Format `tool-result` events as `→ ✅/❌ (<duration>s)` appended to the matching tool-use line
- [ ] 6.6 Format `message-completed` events as `💬 "<first 60 chars>..."` (truncate if >60 chars)
- [ ] 6.7 Format `turn-completed` events as `📊 Turn N — X tokens ($Y)` with formatted cost from microUSD
- [ ] 6.8 After formatting, check if ≥`minIntervalMs` since last signal; if yes and event is `tool-use`, `turn-completed`, or `turn-failed`, call `signalFn` with the joined buffer lines prefixed by a `### 🤖 <phase> — running` header
- [ ] 6.9 `flush()` — send final signal with remaining buffer, regardless of interval
- [ ] 6.10 Track turn count as an incrementing counter, reset per reporter instance

## 7. Workflow signal and state for activity progress

- [ ] 7.1 Define `activityProgressSignal = defineSignal<[string]>("activityProgress")` in workflow.ts
- [ ] 7.2 Add `activityDetail: string` state variable (initially empty)
- [ ] 7.3 Register signal handler: `setHandler(activityProgressSignal, (md) => { activityDetail = md; updateDashboard(); })`
- [ ] 7.4 Update `renderDashboard()` to include `activityDetail` between the status header and timeline table when non-empty
- [ ] 7.5 Clear `activityDetail = ""` when a phase completes (before pushing the phase entry), so stale output doesn't leak across phases
- [ ] 7.6 Update dashboard size limit test: rendered dashboard with 10 activity lines is under 4096 bytes

## 8. Wire ActivityProgressReporter into activities

- [ ] 8.1 In each activity (specifyActivity, implementActivity, reviewActivity), obtain the parent workflow handle via `Context.current().info.workflowExecution`
- [ ] 8.2 Create a `signalFn` that uses a Temporal Client to signal the parent workflow's `activityProgress` signal
- [ ] 8.3 Create an `ActivityProgressReporter` instance with the signalFn and phase name
- [ ] 8.4 Wrap the phase runner's EventSink (or inject an observer) so that each `AgentStreamEvent` is also passed to `reporter.push(event)`
- [ ] 8.5 Call `reporter.flush()` after the phase runner returns (in a finally block)

## 9. ActivityProgressReporter tests

- [ ] 9.1 Test: `tool-use` event formats as `⚡ <source> \`<tool>\``
- [ ] 9.2 Test: `tool-result` after `tool-use` appends `→ ✅ (<duration>s)`
- [ ] 9.3 Test: `message-completed` truncates text at 60 chars
- [ ] 9.4 Test: `turn-completed` formats tokens with commas and cost from microUSD
- [ ] 9.5 Test: buffer caps at 10 entries (push 12, signal contains only last 10)
- [ ] 9.6 Test: signal is not sent if <2s since last signal (for non-immediate events)
- [ ] 9.7 Test: signal is sent immediately on `tool-use` if ≥2s since last signal
- [ ] 9.8 Test: `flush()` sends remaining buffer as final signal
- [ ] 9.9 Test: signal payload starts with `### 🤖 <phase> — running` header

## 10. Workflow activity-progress integration tests

- [ ] 10.1 Test: `activityProgress` signal updates `activityDetail` and triggers `setCurrentDetails`
- [ ] 10.2 Test: dashboard includes activity detail section when `activityDetail` is non-empty
- [ ] 10.3 Test: `activityDetail` is cleared on phase transition
- [ ] 10.4 Test: full dashboard with activity detail is under 4096 bytes

## 11. Final validation

- [ ] 11.1 `npm run typecheck` passes
- [ ] 11.2 `npm test` passes (all existing + new tests)
- [ ] 11.3 `npm run lint:boundaries` passes
