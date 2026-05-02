# Task 11 Review — Donor-Style Scheduled Pickup Workflow (Verification Pass)

## Review Scope

Verification-only pass on branch `feat/temporal-simplest-workflow` at `96609d3` against the authoritative artifact. HEAD is unchanged since the previous review (`20260429T130449330320Z`). Verified whether the three prior findings were addressed.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-11.md` — donor-style scheduled pickup workflow.

## Acceptance / Spec Coverage

No re-assessment performed; the prior review's AC table remains valid. The single DoD gap (fake-agent pickup e2e path) identified previously is still open — see verification below.

## Previous Review Verification

Previous review: `20260429T130449330320Z`

| # | Finding | Severity | Status | Evidence |
|---|---------|----------|--------|----------|
| 1 | Missing e2e fake-agent pickup path (DoD violation) | Must Fix | **Partially fixed** | `run-e2e.ts:225-232` has the `intakeMode === 'pickup'` branch that executes `pickupWorkflow` through the fake-agent stack. `config.ts` supports the mode and `config.test.ts:35-39` tests parsing. However, `run-e2e.test.ts` only uses `intakeMode: 'manual'` — no test case actually invokes the pickup path. The DoD requires "at least one fake-agent verification path exercises scheduled pickup-driven workflow start/resume behavior." The plumbing is present but the verification path is not exercised. |
| 2 | `startPickupWorkflows` opens a Temporal Connection per invocation with no cancellation coordination | Should Fix | **Not fixed** | `pickup-activities.ts:29-39` unchanged. |
| 3 | Legacy cron workflow termination is fire-and-forget (no log line) | Should Fix | **Not fixed** | `worker.ts:99-105` unchanged; no `log.info` or `console.log` added. |

## Findings

### Must Fix

- **(Prior #1, partially fixed) No e2e test exercises the pickup intake path.** The `run-e2e.ts` pickup branch exists (`intakeMode === 'pickup'`), but no test in `run-e2e.test.ts` or elsewhere sets `intakeMode: 'pickup'` and runs a full fake-agent e2e cycle through `pickupWorkflow`. Add at least one test (or test configuration) that exercises the existing pickup branch to satisfy the DoD requirement.

### Should Fix

- **(Prior #2, not fixed) Per-invocation Temporal Connection in `startPickupWorkflows`** (`pickup-activities.ts:29-39`). Consider either caching the connection at worker startup or documenting the design choice as acceptable given the short-lived nature of pickup ticks.
- **(Prior #3, not fixed) Legacy cron termination is silent** (`worker.ts:99-105`). Add a `console.log` or structured log line after the `.terminate()` call succeeds so operators can see the one-time migration event in production logs.

## Out-of-Scope Follow-Ups

- All items from the prior review remain valid and are already captured in `.ai/tech-debt.md` (Task 11 section).

## Rejected Noise

- No new items.

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 0
- Verification Partially Fixed: 1
- Verification Not Fixed: 2
- Verification Not Applicable: 0

## Recommended Next Actions

1. **Add a pickup-mode e2e test case** — either a new `it(...)` block in `run-e2e.test.ts` with `intakeMode: 'pickup'`, or a live harness invocation that sets `E2E_INTAKE_MODE=pickup`. The plumbing in `run-e2e.ts` is ready; only the test trigger is missing.
2. Add a log line in `stopLegacyPickupCronWorkflow` (`worker.ts:101`) after the successful `.terminate()` call.
3. Optionally document the per-invocation connection pattern in `pickup-activities.ts` if caching is not pursued.
