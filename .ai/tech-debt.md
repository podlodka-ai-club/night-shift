# Tech Debt

## From Task 1 review (20260427T221936203486Z)

- `ensureProjectStatusOptions` is exported but not called independently from the workflow — only embedded inside `getTopReadyIssue` and E2E seeding. Later tasks should wire it as an explicit, independently retriable workflow step or pickup entry point.
- ~~`BLOCKED_REASON_BOARD_SIGNAL_RULES` is defined and frozen but no runtime code consumes it yet. Wire into webhook/signal dispatch logic in Task 2+.~~ **Resolved** in Task 8: `resolveWorkflowTriggerAction` in `intake.ts` now consumes the rules table at runtime.

## From Task 2 review (20260427T231034353018Z)

- Provider-specific constants (`CODEX_COMMAND`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT`) are exported from `activity-deps.ts` and consumed by the legacy CLI path. Encapsulate within the adapter factory when the legacy `codex()` CLI path is retired (Task 3+).
- `AgentThreadDeps` retains Codex-specific method names (`createCodexThread`, `resumeCodexThread`). Rename to provider-neutral names when a second provider is introduced.
- Schema registry → contract bridging is manual: `getAgentSchema().schema.parse` is wrapped into `StructuredTurnContract` at each call site. Build a single registration-time bridge when more schemas are added.
- Nullable normalization inconsistency across phase contracts: `ReviewerResponse` uses a two-pass parse; `SpecifyResponse` and `ImplementResponse` do not. Unify the pattern when all three phases are wired into the workflow (Task 3+).


## From Task 3 review (20260428T080019719244Z)

- ~~Review phase is a terminal no-op: `currentPhase` transitions to `'review'` then the workflow returns immediately. Wire the review-phase retry loop when review-phase activities are implemented.~~ **Resolved** in Task 6: review phase now runs the full happy path to Ready to merge.
- ~~`implementRetry` and `resume` signal handlers are registered but permanently gated off (`const false`). Activate them with their respective phase loops when implement/review retry logic is added.~~ **Resolved** in Tasks 5–7: all signal handlers are now active and gated by `allow*` flags.

## From Task 4 review (20260428T094730759513Z)

- `openspec` binary availability is assumed but not verified at worker startup. If missing, `execFile` throws a cryptic `ENOENT`. Add a startup check or wrap the error with a better message.
- `seedIssueInProject` parameter `initialStatusName` (`e2e/src/live-github.ts`) accepts untyped `string` instead of `ProjectStatusName`. Add the type annotation to catch invalid status names at compile time.
- `isRetryableProjectSelectionError` (`e2e/src/live-github.ts`) only recognizes "Ready" and "Backlog" error messages. Future phases selecting from other statuses would not be retried. Consider a generic pattern match.
- `updatePullRequest` (`activity-github-pull-request.ts`) falls back to dummy title/body defaults when none is provided. Currently all callers supply explicit values, but the fallback is misleading for future use. Consider requiring title/body or separating the update signature.

## From Task 5 review (20260428T133031690060Z)

- ~~`ImplementPhaseContractError` discards the original error cause when wrapping parse or `AgentContractError` failures. Pass `{ cause }` to preserve stack context for debugging.~~ **Fixed** in follow-up (20260428T134128583856Z): constructor now accepts and assigns `cause`.
- ~~Partial worktree recovery only checks directory existence (`pathExists`), not git state validity. A worktree left in a corrupted state (e.g., interrupted `git worktree add`) will be returned as valid and produce cryptic downstream failures. Add git state validation or cleanup-on-corruption when cleanup policy is finalized in Task 9.~~ **Resolved** in Task 9: `isHealthyIssueWorktree` validates git state via `rev-parse --show-toplevel`; corrupt worktrees are cleaned up and recreated.
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

## From Task 8 review (20260428T192303284223Z)

- Webhook bridge/event ingestion is explicitly excluded from task 8. Should be addressed in a future task per the migration map Stage 10.
- E2E repeated-intake deduplication test: the orchestrator unit/integration tests prove idempotency, but the E2E suite (`run-e2e.test.ts`) lacks a test proving repeated intake for the same issue avoids workflow duplication in the live harness context.
- `buildManualCandidate` (`intake.ts`) leaves `startPhase` as `undefined` when `currentStatusName` is `In review`. This is correct for the signal path but semantically incomplete. Document explicitly or add a guard if `In review` items should never trigger a start.
- ~~`buildManualCandidate` has no unit tests. Add tests verifying `Backlog`→specify, `Ready`→implement, `In review`→undefined startPhase mappings.~~ **Resolved** in follow-up: `intake.test.ts` now covers all three `buildManualCandidate` mappings.
- `parseClientArgs` (`client.ts`) hardcodes 3 of 8 canonical status names (`Backlog`, `Ready`, `In review`) for manual intake. Document why only these are supported or extend when more statuses become relevant.
- Environment-variable status-name overrides (`client.ts:76-81`) are not validated against `CANONICAL_PROJECT_STATUS_NAMES`. Invalid custom status names are silently accepted and only fail at workflow runtime.

## From Task 8 final review (20260428T194428344120Z)

- ~~`handlePhaseFailure` (`workflows.ts:96-113`) cleanup error can replace the original phase error.~~ **Resolved** in final-final pass: `preserveOriginalPhaseFailure` (workflows.ts:115-121) wraps cleanup in try-catch with empty catch, preserving the original error.
- ~~`handleWorkflowTrigger` signal path (`intake.ts:117, 128`) does not catch `WorkflowNotFoundError`.~~ **Resolved** in final-final pass: both signal paths (intake.ts:122, 141) now catch `WorkflowNotFoundError` and return noop.
- Signal handlers (`workflows.ts:120-131`) silently discard signals when guard flags are false. Operators get no feedback. Consider updating `shellState.latestActivity` on discard for observability.
- `client.ts` top-level error handler (`console.error(err)`) does not unwind the `.cause` chain. Temporal's `WorkflowFailedError` wraps the actual cause; operators see only the outermost message.
- `buildPhaseFailureComment` (`workflows.ts:418`) suggests `readyStatusName` for review phase failures where a PR already exists. Consider suggesting `inReviewStatusName` for review failures.
- ~~`CleanupWorktreeInput` and `cleanupWorktree` activity are declared in `shared.ts` and `activity-worktree.ts` but never wired into any phase or workflow. Remove or wire into Task 9 cleanup policy.~~ **Resolved** in Task 9: `cleanupWorktree` is now wired into the success path of the phased workflow via `cleanupSuccessfulWorktree`.

## From Task 9 review (20260428T205106670470Z)

- Partial worktree recovery (`isHealthyIssueWorktree`) only checks `rev-parse --show-toplevel`. A deeper health check (e.g. HEAD validity, index integrity) may be warranted if corruption patterns are observed in production. Low priority.
- `cleanupLocalWorktree` deletes the local branch on success-path cleanup while the remote branch/PR still exists. Document or guard against re-entry after cleanup if the workflow is ever extended to allow post-cleanup operations on the same ticket.

## From Task 10 review (20260429T090852608332Z)

- E2E config migration: `e2e/src/config.ts` still uses its own `E2E_*` env-var contract instead of the shared config loader. Migrate to the shared config layer in a future task.

## From PR #5 Port Task 10 review (20260503T173254007840Z)

- `OutputSchemaSmokePayload` in `smoke-support.ts` is defined as a standalone interface, not derived from the `SCHEMA` constant in `smoke-output-schema.ts`. If either evolves, they can silently diverge. Consider co-locating or adding a compile-time assertion. Low priority since both are smoke-test-only artifacts.
- `classifyToolProviderItem` catch-all heuristic (`smoke-support.ts:97`) uses `type.includes('tool')` which could false-positive on future provider event types containing "tool" in the name. Consider a known-type allowlist if the classification is reused beyond smoke scripts.

## From Task 11 review (20260429T130449330320Z)

- `createTemporalWorkflowTriggerDeps` (`intake.ts:179`) hardcodes `TASK_QUEUE` from `shared.ts` instead of accepting a configurable task queue parameter. If `config.temporal.taskQueue` differs from the constant, child workflows started by scheduled or manual pickup would be placed on the wrong queue. Pre-existing pattern affecting both the scheduled and manual CLI paths.
- Webhook bridge/event ingestion remains explicitly deferred per task-11 scope.

## From Task 12 review (20260429T230536031610Z)

- ~~`worker.ts` connection cleanup: if `signalConnection.close()` throws in the `finally` block, `connection.close()` is never called. Use nested try/finally or `Promise.allSettled`-style cleanup. Also, if `Connection.connect` throws before the `try` block, the already-opened `NativeConnection` leaks.~~ **Resolved** in verification pass (20260429T231931990574Z): `openWorkerConnections` and `closeWorkerConnections` now handle both failure modes with independent try/catch blocks. Covered by tests.
- ~~Late progress signals can throw `WorkflowNotFoundError` if the workflow completes between activity start and signal delivery. Add catch at the signal callsite in `worker.ts` or `activity-deps.ts`.~~ **Resolved** in verification pass (20260429T231931990574Z): `signalActivityProgress` in `activity-deps.ts` now catches `WorkflowNotFoundError`.
- `forwardFallbackTurnEvents` in `activity-agent-turn.ts` is likely dead code — `assertCodexTurnResult` already maps `items` → `events`. If intended for future non-Codex adapters, add a comment; otherwise remove.
- AC5 liveness/silence fallback is not implemented. The spec says "may", so acceptable for now, but implement a heartbeat-based liveness indicator if workflows appear frozen during long agent turns.

## From PR #5 Port Task 1 review (20260503T095612387747Z)

- Port the `SpecifyTurnRunner` pluggable interface from the donor branch to enable live-eval mode when live-eval is scoped.
- ~~Add cost/token tracking fields (`costMicroUsd`, `totalTokens`, `recordedUsage`) to eval results when live-eval is added.~~ **Resolved**: `specify-replay.ts` includes `costMicroUsd`, `totalTokens`, and `recordedUsage` in both fixture schema and result types.
- ~~Port remaining donor fixtures (`cli-flag-addition`, `multi-capability-recurrence`, `out-of-scope-feature`, `prior-draft-iteration`) to strengthen the replay regression corpus. `duplicate-files` and `path-policy-violation` ported in follow-up iteration.~~ **Resolved**: all 9 donor fixtures ported plus 4 additional (13 total).
- ~~Add a CLI entry point for running the replay suite (donor has `eval-specify.ts`).~~ **Resolved**: `orchestrator/src/cli/eval-specify.ts` with `npm run eval:specify`.
- ~~Extend fixture expectations to support `minOpenQuestions` / `maxOpenQuestions` for richer regression assertions.~~ **Resolved**: `specifyReplayFixtureSchema` and `describeExpectationMismatch` now support both fields.

## From PR #5 Port Task 2 review (20260503T120622497283Z)

- Port an `ImplementTurnRunner` pluggable interface from the donor branch to enable live-eval mode when live-eval is scoped (mirrors the existing Task 1 tech-debt item for `SpecifyTurnRunner`).
- Add more implement fixtures to strengthen the regression corpus (e.g., duplicate-paths violation, dotdot-traversal, multiple follow-ups, large file output).
- ~~Extract shared eval helpers (`recordedUsageSchema`, `toErrorMessage`) into a common module to reduce duplication between specify and implement harnesses.~~ **Partially resolved**: `recordedUsageSchema` and `toErrorMessage` extracted to `orchestrator/src/eval/replay-common.ts`. Shared CLI scaffolding (`filterFixtures`, `isDirectCliExecution`, `isFailureResult`, `renderText` pattern) remains duplicated between `eval-specify.ts` and `eval-implement.ts`; extract when a third phase harness is added.

## From PR #5 Port Task 3 review (20260503T122031388057Z)

- ~~Specify and implement phase step builders embed the hardening preamble in the user-message prompt but do not pass it as `systemPrompt` on their `AgentStep`. The review phase correctly separates the preamble into `REVIEWER_SYSTEM_PROMPT` via `step.systemPrompt`. Align specify and implement to use the same pattern for provider-level authority separation. Low priority since the preamble is already in the prompt text.~~ **Resolved** in verification pass (20260503T122559570631Z): `SPECIFY_SYSTEM_PROMPT` and `IMPLEMENT_SYSTEM_PROMPT` now exported from their respective prompt modules and threaded through `step.systemPrompt`. Tests verify the system-prompt field.

## From PR #5 Port Task 4 review (20260503T124145850772Z)

- Live eval record flow: spec point 4 envisions writing live output back into fixture-compatible JSON (`recordedFinalText`, `recordedUsage`, `recordedCostMicroUsd`). Data is already captured in `LiveTurnResult`; only the serialization-to-fixture-JSON step is missing. Implement when fixture corpus needs to be refreshed from live runs.
- Shared CLI scaffolding extraction for eval CLIs: `filterFixtures`, `isDirectCliExecution`, `isFailureResult`, `renderText`, `parseTimeoutMs`, `parseJudgeOptions`, `parseNonNegativeInt`, and `CliOptions` are near-identical between `eval-specify.ts` and `eval-implement.ts`. Already partially tracked in Task 2 tech-debt; extract when a third phase harness is added. (Updated in Task 5 review to include judge-related helpers.)
- Targeted activity-deps factory for eval: `createActivityDependencies()` pulls in Temporal context deps, GitHub tokens, and filesystem wiring that the eval runner doesn't need. A slimmer factory passing only `createCodexThread`/`resumeCodexThread` would reduce surface. Low priority since missing-context paths silently no-op.

## From PR #5 Port Tasks 2–5 combined review (20260503T132642649240Z)

- ~~`wrapUntrustedInput` body escaping gap: the helper escapes the `source` attribute but inserts the body verbatim between `<untrusted-input>` tags. A payload containing `</untrusted-input>` can break out of the boundary. Escape or encode closing-tag sequences in the body and add hostile-payload regression tests.~~ **Resolved** in final-review fixes (e207027): `normalizeBody()` now escapes `</untrusted-input>` closing tags; hostile-payload regression tests added in `prompt-hardening.test.ts`.
- ~~Judge revision cap in harness: the `maxRevisions` cap of 2 is enforced only in the CLI (`parseJudgeOptions`), not in the exported harness functions (`runSpecifyLiveFixture`, `runImplementLiveFixture`). Direct callers can bypass the cap. Move the enforcement into the harness layer.~~ **Resolved** in final-review fixes (e207027): `normalizeLiveJudgeMaxRevisions()` in `live-judge.ts` clamps to `MAX_LIVE_JUDGE_REVISIONS`; both harness functions call it. Test coverage added.
- ~~`createDefaultLiveTurnRunner` bypasses the structured turn path: it calls `session.run()` directly instead of `runStructuredAgentTurn()` / `runAgentTurnWithHeartbeat()`, skipping structured-output repair behavior. Evaluate whether live eval should route through the real repair path, or explicitly document the behavioral difference.~~ **Resolved** in final-review fixes (e207027): `createDefaultLiveTurnRunner` now routes through `runStructuredAgentTurn` when `outputSchema` and `parseOutput` are provided, matching the real runtime repair path. Test in `live-common.test.ts` verifies repair behavior.
- Structured-output repair prompt hardening: `runStructuredAgentTurn()` echoes prior prompt/output in repair prompts without `<untrusted-input>` wrapping. Not in task-3 scope, but would complete the hardening story.
- Implement fixture corpus expansion: add fixtures for duplicate `filesWritten` paths, `..` traversal, backslash separators, missing required fields. (Partially overlaps Task 2 tech-debt item.)
- ~~Injectable/testable default live runner: `createDefaultLiveTurnRunner` hard-wires `createActivityDependencies()` and `createCodexAgentAdapter()`. Refactor to accept deps injection for focused testing of timeout, usage-from-events, and cost capture.~~ **Resolved** in final-review fixes (e207027): `createDefaultLiveTurnRunner` now accepts an optional `DefaultLiveTurnRunnerDeps` parameter; `live-common.test.ts` exercises the injected deps path.
- Combined generator+judge rolled-up cost/tokens per fixture: currently generator and judge telemetry are separated. A combined roll-up could improve operator visibility.

## From PR #5 Port Task 6 review (20260503T150348665779Z)

- `SelectedProjectIssue` lacks a `labels` field. Donor prompts render `Labels: ${ticket.labels.join(", ")}` in ticket blocks. Add `labels: string[]` to the interface and populate from the GitHub project query to achieve full donor prompt parity.
- `IssueComment` has only `id` and `body`. Donor prompts render `### @${authorLogin} — ${createdAt}` per comment. Add `authorLogin` and `createdAt` fields and render donor-style comment headers to achieve full donor prompt parity.
- ~~Review prompt builder (`BuildReviewPromptInput`) lacks an optional `retryFeedback` field. Donor PR5 review prompt renders a `## Retry feedback` section with `<untrusted-input source="previous-attempt-error">` wrapping when retry context is present. Add the field and rendering to maintain prompt-level donor parity even if the current caller does not populate it yet.~~ **Resolved** in verification pass (20260503T150947947061Z): `BuildReviewPromptInput` now has `retryFeedback?: ReviewRetryFeedback`; `renderRetryFeedback` renders the section; test in `review-phase.test.ts` verifies it.
- `buildPromptHardeningPreamble` in `prompt-hardening.ts` uses shorter/looser phrasing than the donor-faithful phase-specific system prompts (e.g., "claims about the current system state must cite a concrete artifact" vs "claims about how the system currently behaves must cite a file or symbol"). Only consumed by eval judge prompts (`specify-live.ts`, `implement-live.ts`). Either align the wording or add a one-line comment documenting the intentional difference. Low priority.

## From PR #5 Port Task 7 multi-provider foundation review (20260503T160004636280Z)

- ~~`computeModelCostMicroUsd` (`agent-pricing.ts`) returns `0` for unknown models instead of `undefined`. This silently hides cost tracking gaps when new models are used without adding them to `MODEL_PRICING`. Consider returning `undefined` to distinguish "no cost data" from "zero cost".~~ **Resolved** in verification pass (20260503T162308119189Z): now returns `undefined` for unknown models. Test in `agent-pricing.test.ts` covers this path.
- `resolveAgentProviderSelection` silently routes unrecognized model strings to the default provider's backend (e.g., `{ model: 'llama-3-70b' }` → codex). The model passes through to the SDK, which will fail at runtime. Add model validation when the CLI surface is added in Tasks 8/9.
- `parseClaudeUsage` (`activity-deps.ts:481`) charges cache-creation tokens at the standard input rate. Anthropic bills cache-creation at 1.25× standard input. The current formula undercharges. A comment now documents the approximation inline, but the formula is unchanged. Either add `cacheCreationInputPer1M` to `ModelPricing` or accept the documented approximation.
- ~~`createProviderAgentAdapter` (`activity-deps.ts:273-275`) uses a ternary instead of an exhaustive switch on `resolved.provider`. Adding a third provider silently falls through to codex. Add `switch` with `default: never` when a third provider is introduced.~~ **Resolved** in verification pass (20260503T161605938275Z): now uses `switch` with `default: assertNever(resolved.provider)`.


## From PR #5 Port Task 8 live-eval CLI and recording parity review (20260503T165417690283Z)

- ~~`persistRecordedFixtures` in both `eval-specify.ts` and `eval-implement.ts` spreads the full fixture object including `fixturePath` (added by the loader) into the JSON written to disk. Destructure out `fixturePath` before serialization to avoid writing the unwanted property into fixture files.~~ **Resolved** in verification pass (20260503T165857424059Z): both CLIs now destructure out `fixturePath` before serialization; test assertions verify `fixturePath === undefined` in written fixture JSON.
- ~~`--judge-provider` / `--judge-model` CLI flags are not exposed (donor PR #5 has them). Judge provider/model routing is available at the harness API level (`LiveJudgeOptions.provider`/`.model`) but not surfaced as CLI flags. Add when Task 9 enables judge-aware recording or judge-specific provider selection becomes operator-facing.~~ **Resolved** in the current Task 9 working tree (pending commit): both `eval-specify.ts` and `eval-implement.ts` now expose `--judge-provider`, `--judge-model`, and `--max-revisions` with cross-provider judge selection.

## From PR #5 Port Task 9 review (20260503T171008011858Z)

- `createDefaultLiveTurnRunner` guard (`live-common.ts:71`) allows `outputSchema` to reach the unstructured path (line 108) without `parseOutput`, producing unvalidated structured output. Pre-existing from Task 5/7 — not introduced by Task 9. Low priority since no caller currently passes `outputSchema` without `parseOutput`.
- `aggregateUsageFromTurns` (`live-common.ts:175–184`) discards all accumulated usage if any single turn lacks parseable usage, silently zeroing out the aggregate. Pre-existing from Task 4/5. Consider accumulating partial usage and flagging incompleteness.
- ~~Test parity gap between `specify-live-eval.test.ts` and `implement-live-eval.test.ts`: implement is missing judge-pass-after-revision and judge-parse-error tests; specify is missing judge-runtime-error test. Each file covers one failure mode but not both.~~ **Resolved** in the current Task 9 working tree (pending commit): live harness tests now cover judge pass-after-revision, judge parse failures, and judge runtime failures symmetrically across specify/implement.

## From PR #5 Port Tasks 6–10 combined review (20260503T174318815338Z)

- ~~Donor judge system prompt uses a detailed R1–R6 rubric (faithfulness, evidence, assumptions, questions, scope, definition-of-done) with specific violation codes and structured JSON output contract. Current main's `SPECIFY_JUDGE_SYSTEM_PROMPT` and `IMPLEMENT_JUDGE_SYSTEM_PROMPT` use the generic `buildPromptHardeningPreamble` preamble instead. Port the donor's purpose-built rubric for higher-quality judge critiques.~~ **Resolved** in re-review (20260503T175607017085Z): both `SPECIFY_LIVE_JUDGE_SYSTEM_PROMPT` and `IMPLEMENT_LIVE_JUDGE_SYSTEM_PROMPT` in `live-judge.ts` now contain the full R1–R6 rubric with violation codes and structured JSON output contract.
- ~~Two donor implement fixtures (`refined-bug-fix.json`, `vague-scope-creep.json`) are missing from the current corpus. Port them for full fixture parity.~~ **Resolved** in re-review (20260503T175607017085Z): both fixtures are present in `orchestrator/eval/fixtures/implement/`.
- ~~`orchestrator/eval/demo/PROJECT.md` omits several donor details: architecture tree inline comments, RecurrenceRule behavioral semantics, `date-fns` specificity in style guide, and "(explicit, do not implement)" qualifier in Out of Scope. Restore for fixture realism.~~ **Resolved** in re-review (20260503T175607017085Z): all four detail gaps are present in the current file.
- ~~Donor `smoke-claude-agent.ts` exercises `session.runStreamed()` (streaming path); current main only tests `session.run()`. Add a streaming smoke path if streaming is supported in the current adapter.~~ **Resolved** in re-review (20260503T175607017085Z): current main covers the streaming path via `onEvent` callback in the second turn of `smoke-claude-agent.ts`. The `AgentSession` seam intentionally exposes `run()` with `onEvent` rather than a separate `runStreamed()` method; this is documented in the smoke script and README.


## From make-check lint fix review (20260503T185301543850Z)

- ~~`renderDiff` UTF-8 truncation (`review/prompt.ts:104`) can produce a trailing U+FFFD replacement character when the byte-slice boundary falls inside a multi-byte codepoint. Not a regression (old `Buffer` path had the same behavior), but worth hardening with a backward scan of up to 3 continuation bytes before decoding. Low priority.~~ **Resolved** in the current make-check fix working tree (pending commit): `decodeUtf8Prefix` performs the backward continuation-byte scan and truncates at code point boundaries. Test in `review-phase.test.ts` confirms no U+FFFD replacement characters.
- Fake-agent Claude session stubs (`e2e/src/fake-agent.ts:96-105`) are a line-for-line duplicate of the Codex thread stubs. Extract into a single provider-agnostic factory when a third provider is added. Test-only duplication; low priority.