# Task 2 Review — Typed Phase-Runtime Foundation

## Review Scope

Reviewed all branch files against the authoritative artifact `docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-2.md`. Inspected source, tests, and ran `make check` (68 orchestrator tests + 20 e2e tests pass, builds clean). Focused on: phase response contracts (`phases/*/response.ts`), adapter/session boundary (`activity-deps.ts`), shared structured-turn helper (`activity-agent-turn.ts`), sequence caller migration (`activity-agent-sequence.ts`), and all associated test files.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-2.md` — Land the typed phase-runtime foundation on the current execution path.

## Acceptance / Spec Coverage

All five acceptance criteria appear satisfied:

1. **AC1 (Ready-path end-to-end):** The current `Ready`-path caller in `activity-agent-sequence.ts` runs through the adapter-backed `runStructuredAgentTurn` helper. Workflow tests in `workflow-success.test.ts` and `workflow-failure.test.ts` confirm outward GitHub behavior is unchanged.
2. **AC2 (Contract modules reject malformed payloads):** `SpecifyResponse`, `ImplementResponse`, and `ReviewerResponse` each have targeted unit tests in `phase-response-contracts.test.ts` covering valid shapes, missing required fields, duplicate paths, invalid paths, and invalid severities.
3. **AC3 (Checkpoint/resume preserved):** Checkpoint tests in `activity-agent-sequence-checkpoint.test.ts` cover resume-from-heartbeat, pending-step finalization (both structured and prompt), legacy `pendingStructuredStep` migration, retry-after-failure, and stale-checkpoint rejection.
4. **AC4 (Adapter parity):** Runtime tests in `activity-agent-sequence-runtime.test.ts` cover thread identity, cancellation signal propagation, progress events (via heartbeat count), and structured output parsing.
5. **AC5 (Contract vs runtime failure classification):** `activity-agent-turn.test.ts` explicitly verifies `AgentContractError` for repair-exhausted schema failures and confirms infrastructure errors are *not* wrapped as `AgentContractError`.

## Previous Review Verification

Verification was skipped — no previous review was supplied.

## Findings

### Must Fix

*(none)*

### Should Fix

- **S1 — Repair prompt re-includes full original prompt verbatim** (`activity-agent-turn.ts:138-148`): `buildStructuredOutputRepairPrompt` concatenates the full original prompt + error context + the full invalid response. For large prompts or large invalid outputs, this can exceed LLM context limits. Consider truncating the invalid output (similar to `truncateCheckpointFinalResponse`) and summarizing the original prompt intent rather than repeating it in full.

- **S2 — Checkpoint resume does not re-validate `parsedOutput` against the schema** (`activity-agent-sequence.ts:60-68`): When a pending structured step is finalized on resume via `applyPendingStepCompletion`, the `parsedOutput` from the serialized checkpoint is accepted without re-parsing through the schema. If Temporal heartbeat serialization corrupts the payload (e.g., `Date` → string, `BigInt` → number), the corrupted value silently propagates into `outputs`. Consider re-validating against the step's contract on resume.

- **S3 — `AgentThread` type alias adds no semantic value** (`activity-deps.ts:41`): `type AgentThread = AgentSession` creates naming confusion — `activity-agent-sequence.ts` imports `AgentThread` while `activity-agent-turn.ts` uses `AgentSession`. Pick one name or make them structurally distinct if they represent different lifecycle stages.

- **S4 — Duplicate runtime assertion in sequence caller** (`activity-agent-sequence.ts:144-155`): `assertActivityThread` re-validates the adapter return shape that `createLazyCodexSession` already validates via `assertCodexThread`. Since the adapter contract guarantees `AgentSession`, the caller-side assertion is redundant. Remove it or document why double-validation is intentional.

- **S5 — `activity-agent-turn.test.ts` missing happy-path test**: No test for the case where the first parse succeeds immediately (no repair needed). The test suite only covers repair and failure paths. Add a test confirming single-turn success returns parsed output without a second call.

- **S6 — JSON schema sources are looser than validation schemas**: The zodV3-based `*JsonSchemaSource` objects (sent to the agent as `outputSchema`) lack the refinements (path regex, min lengths, `superRefine` checks) present in the zod v4 validation schemas. This means the schema hint permits values that the parser will reject — a silent contract mismatch that may cause avoidable repair turns.

- **S7 — Double heartbeat per step** (`activity-agent-sequence.ts:122-124`): Two synchronous heartbeats are emitted per step (one with `pendingStep`, one without). The two-phase commit pattern is correct for crash safety, but should have a brief comment explaining the protocol for future maintainers.

## Out-of-Scope Follow-Ups

- **Provider-specific constants exported from adapter boundary**: `CODEX_COMMAND`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT` are module-level exports consumed by the legacy CLI path. These should be encapsulated within the adapter factory when the legacy path is retired (Task 3+).
- **`AgentThreadDeps` retains Codex-specific method names** (`createCodexThread`, `resumeCodexThread`): The adapter interface is provider-neutral but the underlying deps interface hard-codes Codex naming. Rename when a second provider is introduced.
- **Schema registry → contract bridging is manual**: `getAgentSchema().schema.parse` is manually wrapped into `StructuredTurnContract` at each call site. A single registration-time bridge would reduce duplication (relevant when more schemas are added in later tasks).
- **Nullable normalization inconsistency across phases**: `ReviewerResponse` uses a two-pass parse for nullable fields; `SpecifyResponse` and `ImplementResponse` do not. Unify the pattern when all three phases are wired into the workflow (Task 3+).

## Rejected Noise

- **`interval.unref?.()` is a Node-only API**: This is running exclusively in a Node.js Temporal worker; the call is appropriate and idiomatic.
- **`onEvent` fires post-turn rather than during streaming**: The Codex SDK `thread.run()` returns events in the result object (`.items`); the adapter faithfully forwards them. Streaming dispatch is an SDK limitation, not an adapter bug.
- **`ImplementResponse` allows empty `content` strings**: Empty file writes are a valid implementation operation (e.g., creating an empty `.gitkeep`). The asymmetry with `SpecifyResponse` (`.min(1)`) is intentional — spec files must have content.
- **`SpecifyResponse` path regex rejects underscores in spec directory names**: The regex `[a-z0-9-]+` follows the donor branch convention. If underscores are needed, it's a future contract change, not a Task 2 bug.

## Review Metadata

- Actual Review Mode: artifact+branch
- Fallback Reason: none
- Verification Attempted: false
- Verification Fixed: 0
- Verification Partially Fixed: 0
- Verification Not Fixed: 0
- Verification Not Applicable: 0

## Recommended Next Actions

1. Add the happy-path test for `runStructuredAgentTurn` (S5) — trivial, 5-minute fix.
2. Add a comment documenting the double-heartbeat protocol (S7) — 1-line comment.
3. Consider truncating invalid output in the repair prompt (S1) before a real agent smoke run reveals context-limit failures.
4. Evaluate checkpoint re-validation (S2) as a risk item for the prescribed real-agent smoke run — if Temporal serialization is known to be JSON-safe for the current schema shapes, this can be deferred.
5. The `AgentThread` alias cleanup (S3) and duplicate assertion removal (S4) are low-risk refactors that can ride with any next task.
