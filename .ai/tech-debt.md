# Tech Debt

## From Task 1 review (20260427T221936203486Z)

- `ensureProjectStatusOptions` is exported but not called independently from the workflow — only embedded inside `getTopReadyIssue` and E2E seeding. Later tasks should wire it as an explicit, independently retriable workflow step or pickup entry point.
- `BLOCKED_REASON_BOARD_SIGNAL_RULES` is defined and frozen but no runtime code consumes it yet. Wire into webhook/signal dispatch logic in Task 2+.
