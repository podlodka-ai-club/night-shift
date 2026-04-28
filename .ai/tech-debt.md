# Tech Debt

## From Task 1 review (20260427T221936203486Z)

- `ensureProjectStatusOptions` is exported but not called independently from the workflow — only embedded inside `getTopReadyIssue` and E2E seeding. Later tasks should wire it as an explicit, independently retriable workflow step or pickup entry point.
- `BLOCKED_REASON_BOARD_SIGNAL_RULES` is defined and frozen but no runtime code consumes it yet. Wire into webhook/signal dispatch logic in Task 2+.

## From Task 2 review (20260427T231034353018Z)

- Provider-specific constants (`CODEX_COMMAND`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT`) are exported from `activity-deps.ts` and consumed by the legacy CLI path. Encapsulate within the adapter factory when the legacy `codex()` CLI path is retired (Task 3+).
- `AgentThreadDeps` retains Codex-specific method names (`createCodexThread`, `resumeCodexThread`). Rename to provider-neutral names when a second provider is introduced.
- Schema registry → contract bridging is manual: `getAgentSchema().schema.parse` is wrapped into `StructuredTurnContract` at each call site. Build a single registration-time bridge when more schemas are added.
- Nullable normalization inconsistency across phase contracts: `ReviewerResponse` uses a two-pass parse; `SpecifyResponse` and `ImplementResponse` do not. Unify the pattern when all three phases are wired into the workflow (Task 3+).


## From Task 3 review (20260428T080019719244Z)

- Review phase is a terminal no-op: `currentPhase` transitions to `'review'` then the workflow returns immediately. Wire the review-phase retry loop when review-phase activities are implemented.
- `implementRetry` and `resume` signal handlers are registered but permanently gated off (`const false`). Activate them with their respective phase loops when implement/review retry logic is added.