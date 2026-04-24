# Review Phase

Orchestrates the automated code review of PRs produced by `implement-phase`.
Takes a PR in `In review` status, runs a reviewer agent, and produces a
verdict (`ready-to-merge`, `needs-fix`, or `escalate`) with corresponding
GitHub mutations.

## Dependencies

| Module | Purpose |
| --- | --- |
| `src/contracts/review` | `ReviewInput`, `ReviewResult`, `Finding`, `decideVerdict` |
| `src/contracts/events` | `PhaseStarted`, `PhaseCompleted`, `PhaseFailed` |
| `src/adapters` | `AgentAdapter` for the reviewer agent |
| `src/github` | PR diff, review comments, status transitions |
| `src/config` | `reviewPhase.maxDiffBytes`, `reviewPhase.escalationLabel` |

## CLI Usage

```bash
night-shift review <projectItemId> [--iteration <n>]
```

### Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | `ready_to_merge` |
| 1 | `needs_fix` |
| 2 | error |
| 3 | `escalated` |
| 64 | usage error |

## Verdict Table

| Verdict | Condition | PR Action | Item Status |
| --- | --- | --- | --- |
| `ready-to-merge` | No error-level findings | APPROVE + `setPullRequestReady(true)` | `Ready to merge` |
| `needs-fix` | Errors present, iteration < 2 | REQUEST_CHANGES | `Ready` |
| `escalate` | Errors present, iteration ≥ 2 | COMMENT + escalation label | `Blocked` |

## Iteration Model

- `iteration` is supplied by the orchestrator (or CLI flag)
- Iterations 0 and 1 may produce `needs-fix`
- Iteration 2 with errors produces `escalate`
- The phase is stateless; it does not track iterations itself

## Test Recipe

```bash
npm test -- --reporter=verbose src/phases/review/
```
