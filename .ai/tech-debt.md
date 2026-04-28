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

- ~~Review phase is a terminal no-op: `currentPhase` transitions to `'review'` then the workflow returns immediately. Wire the review-phase retry loop when review-phase activities are implemented.~~ **Resolved** in Task 6: review phase now runs the full happy path to Ready to merge.
- `implementRetry` and `resume` signal handlers are registered but permanently gated off (`const false`). Activate them with their respective phase loops when implement/review retry logic is added.

## From Task 4 review (20260428T094730759513Z)

- `openspec` binary availability is assumed but not verified at worker startup. If missing, `execFile` throws a cryptic `ENOENT`. Add a startup check or wrap the error with a better message.
- `seedIssueInProject` parameter `initialStatusName` (`e2e/src/live-github.ts`) accepts untyped `string` instead of `ProjectStatusName`. Add the type annotation to catch invalid status names at compile time.
- `isRetryableProjectSelectionError` (`e2e/src/live-github.ts`) only recognizes "Ready" and "Backlog" error messages. Future phases selecting from other statuses would not be retried. Consider a generic pattern match.
- `updatePullRequest` (`activity-github-pull-request.ts`) falls back to dummy title/body defaults when none is provided. Currently all callers supply explicit values, but the fallback is misleading for future use. Consider requiring title/body or separating the update signature.

## From Task 5 review (20260428T133031690060Z)

- ~~`ImplementPhaseContractError` discards the original error cause when wrapping parse or `AgentContractError` failures. Pass `{ cause }` to preserve stack context for debugging.~~ **Fixed** in follow-up (20260428T134128583856Z): constructor now accepts and assigns `cause`.
- Partial worktree recovery only checks directory existence (`pathExists`), not git state validity. A worktree left in a corrupted state (e.g., interrupted `git worktree add`) will be returned as valid and produce cryptic downstream failures. Add git state validation or cleanup-on-corruption when cleanup policy is finalized in Task 9.
- Quality gate logs (up to 4 KB) are embedded verbatim in the implement retry prompt via `buildRetryFailureMessage`. Consider a secondary truncation or summarization step to avoid inflating prompt token usage on noisy build output.

## From Task 6 review (20260428T151352596798Z)

- ~~`createPullRequestReviewComment` (`activity-github-pull-request.ts:236-239`) omits `commit_id` from the POST body. GitHub documents this as required. Without it, new inline comments fail with 422 errors that are silently swallowed by `isUnresolvableInlineCommentError`. Thread `pullRequestDetails.headSha` through `UpsertPullRequestReviewCommentInput` and include it as `commit_id`.~~ **Fixed** in follow-up: `commit_id: input.commitId` now included in the POST body; `UpsertPullRequestReviewCommentInput` includes `commitId` field.
- ~~`reviewerResponseJsonSchemaSource` (`response.ts:40`) allows empty string for `location.file` while the parser requires `.min(1)`. Add `.min(1)` to the JSON schema source to align with the parser.~~ **Fixed** in follow-up: JSON schema source now uses `zodV3.string().min(1)` for `location.file`.
- `ReviewPhaseContractError` (`errors.ts`) manually assigns `cause` instead of using `super(message, { cause })`. Update to use the standard ES2022 Error cause mechanism, consistent with the task-5 fix for `ImplementPhaseContractError`.
- ~~`reviewIteration` (`workflows.ts:297`) is initialized to 0 and never incremented. The escalation path in `decideReviewVerdict` is dead code until Task 7 wires the needs-fix retry loop and increments the iteration counter.~~ **Resolved** in Task 7: `reviewIteration` is now incremented on `needs_fix` and reset on `resume`.
- ~~Missing `reviewerResponseJsonSchemaSource` alignment test in `phase-response-contracts.test.ts`. The specify and implement schemas have alignment tests; the reviewer schema does not.~~ **Fixed** in follow-up: `phase-response-contracts.test.ts` now includes a ReviewerResponse alignment test.

## From Task 7 review (20260428T175102365479Z)

- `SpecifyPhaseContractError` (`phases/specify/errors.ts`) discards original error cause — constructor accepts no `cause` parameter. Add a `cause` parameter consistent with `ImplementPhaseContractError` and `ReviewPhaseContractError`.
- `ImplementPhaseContractError` (`phases/implement/errors.ts`) manually assigns `cause` instead of using `super(message, { cause })`. Same pattern as `ReviewPhaseContractError` (already tracked in Task 6 tech-debt). Both should use the ES2022 `Error` cause mechanism.
- Duplicated `findErrorInCauseChain` / `describeErrorCauseChain` / `describeWorkflowError` helper functions across `workflows.ts`, `review/phase.ts`, `implement/phase.ts`, and `workflow-shell.test.ts`. Extract to a shared utility module to reduce drift risk.