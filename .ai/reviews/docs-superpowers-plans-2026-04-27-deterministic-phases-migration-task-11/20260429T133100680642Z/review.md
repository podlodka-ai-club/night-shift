# Task 11 Review — Donor-Style Scheduled Pickup Workflow (Verification Pass)

## Review Scope

Verification-only pass on branch `feat/temporal-simplest-workflow` at `96609d3` against the authoritative artifact. HEAD is unchanged since the previous review (`20260429T132327585594Z`). Verified whether the three prior findings were addressed.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-11.md` — donor-style scheduled pickup workflow.

## Acceptance / Spec Coverage

No re-assessment performed; the prior review's AC table remains valid. The single DoD gap (fake-agent pickup e2e path) identified previously is still open — see verification below.

## Previous Review Verification

Previous review: `20260429T132327585594Z`

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 1 | No e2e test exercises the pickup intake path (DoD violation) | Must Fix | **Not fixed** | `run-e2e.test.ts` still only sets `intakeMode: 'manual'` in the full harness config (line 20). The `runConfiguredIntake` dispatch tests (lines 60–104) verify routing logic but do not constitute a fake-agent e2e verification path through `pickupWorkflow`. HEAD unchanged at `96609d3`. |
| 2 | `startPickupWorkflows` opens a Temporal Connection per invocation with no cancellation coordination | Should Fix | **Not fixed** | `pickup-activities.ts:29-39` unchanged. |
| 3 | Legacy cron workflow termination is fire-and-forget (no log line) | Should Fix | **Not fixed** | `worker.ts:99-105` unchanged; no log statement added after `.terminate()`. |

Since prior findings remain unresolved, no fresh full review pass was performed per review protocol.

## Findings

### Must Fix

- **(Prior #1, not fixed) No e2e test exercises the pickup intake path.** `run-e2e.test.ts` only uses `intakeMode: 'manual'` for full fake-agent harness runs (line 20). The `runConfiguredIntake` dispatch tests (lines 60–104) verify the routing function in isolation but do not run a full fake-agent e2e cycle through `pickupWorkflow`. The DoD requires "at least one fake-agent verification path exercises scheduled pickup-driven workflow start/resume behavior." Add a test case (or test configuration) that sets `intakeMode: 'pickup'` and exercises the full fake-agent → `pickupWorkflow` → child workflow path.

### Should Fix

- **(Prior #2, not fixed) Per-invocation Temporal Connection in `startPickupWorkflows`** (`pickup-activities.ts:29-39`). Each pickup tick opens and closes a fresh `Connection`. Consider caching the connection at worker startup or documenting this as an intentional design choice given the expected tick frequency.
- **(Prior #3, not fixed) Legacy cron termination is silent** (`worker.ts:99-105`). The `.terminate()` call succeeds silently. Add a `console.log` or structured log line so operators can observe the one-time migration event in production logs.

## Out-of-Scope Follow-Ups

- All items from the prior review remain valid and are already captured in `.ai/tech-debt.md` (Task 11 section).

## Rejected Noise

- No new items.

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 3
- Verification Not Applicable: 0

## Recommended Next Actions

1. **Add a pickup-mode e2e test case** — add an `it(...)` block in `run-e2e.test.ts` (or a live harness configuration) that sets `intakeMode: 'pickup'` and runs the full fake-agent e2e cycle through `pickupWorkflow`. The plumbing in `run-e2e.ts` is already wired; only the test trigger is missing.
2. Add a log line in `stopLegacyPickupCronWorkflow` (`worker.ts:101`) after the successful `.terminate()` call.
3. Optionally document the per-invocation connection pattern in `pickup-activities.ts` if caching is not pursued.
