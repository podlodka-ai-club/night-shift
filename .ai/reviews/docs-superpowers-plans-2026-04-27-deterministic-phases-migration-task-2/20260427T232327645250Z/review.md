# Task 2 Verification Review — Typed Phase-Runtime Foundation

## Review Scope

Verification-first review of branch `feat/temporal-simplest-workflow` against the authoritative artifact. Verified the seven should-fix findings (S1–S7) from the previous review `20260427T231034353018Z`. Since unresolved findings remain, no fresh full review pass was performed per protocol.

## Source Artifact

`docs/superpowers/plans/2026-04-27-deterministic-phases-migration/task-2.md` — Land the typed phase-runtime foundation on the current execution path.

## Acceptance / Spec Coverage

All five acceptance criteria remain satisfied. The fixes applied since the previous review (checkpoint re-validation, happy-path test, heartbeat comment, invalid-output truncation) strengthen AC3 and AC5 coverage without regressing AC1/AC2/AC4. `make check` is green (confirmed by reviewer instructions).

## Previous Review Verification

| ID | Finding | Status |
|----|---------|--------|
| S1 | Repair prompt re-includes full original prompt | **Partially fixed** — invalid output is now truncated to 16 KB via `truncateRepairPromptInvalidOutput`. The original prompt is still included verbatim. |
| S2 | Checkpoint resume does not re-validate `parsedOutput` | **Fixed** — `validatePendingStepCompletion` now calls `schemaDefinition.schema.parse(pendingStep.output.parsedOutput)` before applying. |
| S3 | `AgentThread` type alias adds no semantic value | **Partially fixed** — alias removed from `activity-deps.ts`, but `e2e/src/fake-agent.ts:2` still imports the non-existent `AgentThread` type. `tsc --build` does not catch this; `tsc --noEmit` does. |
| S4 | Duplicate runtime assertion in sequence caller | **Fixed** — renamed to `assertActivitySession`; single validation point. |
| S5 | Missing happy-path test for `runStructuredAgentTurn` | **Fixed** — test `'returns parsed output immediately when the first response is valid'` exists at `activity-agent-turn.test.ts:28-50`. |
| S6 | JSON schema sources looser than validation schemas | **Not fixed** — `reviewerResponseJsonSchemaSource` still omits `.min(1)` on `summary` and `message` fields that the v4 validation schema enforces, causing avoidable repair turns when the agent returns empty strings. |
| S7 | Double heartbeat per step undocumented | **Fixed** — explanatory comment present at `activity-agent-sequence.ts:125-127`. |

## Findings

### Must Fix

*(none)*

### Should Fix

- **S1-residual — Original prompt not truncated in repair prompt** (`activity-agent-turn.ts:buildStructuredOutputRepairPrompt`): The invalid output is now truncated (good), but the full original prompt is still concatenated verbatim. For large specification prompts this can push repair turns toward context limits. Consider summarizing or truncating the original prompt portion.

- **S3-residual — `e2e/src/fake-agent.ts` imports non-existent `AgentThread` type** (`e2e/src/fake-agent.ts:2`): The type was removed from `activity-deps.ts` but the e2e fake-agent still imports it. This is a latent type error (`TS2305`) that `tsc --build` silently ignores but `tsc --noEmit` catches. Replace with `AgentSession`.

- **S6 — `reviewerResponseJsonSchemaSource` omits `.min(1)` constraints** (`phases/review/response.ts:35-45`): The zodV3 schema source sent to the agent lacks the `min(1)` constraints on `summary` and `message` that `reviewerResponseInputSchema` enforces. An agent returning `""` will pass the schema hint but fail validation, triggering an avoidable repair turn. Add `.min(1)` to the zodV3 source for `summary` and `message`.

## Out-of-Scope Follow-Ups

- All four items from the previous review remain captured in `.ai/tech-debt.md` and are unchanged.

## Rejected Noise

- **S1 full-prompt truncation as a must-fix**: The current prompt sizes in this project are well within LLM context limits. The risk is real but low-severity for the current workload; should-fix is appropriate.
- **S4 re-check**: The assertion was cleanly consolidated; no residual issue.

## Review Metadata

- Actual Review Mode: verify-then-review
- Fallback Reason: none
- Verification Attempted: true
- Verification Fixed: 4
- Verification Partially Fixed: 2
- Verification Not Fixed: 1
- Verification Not Applicable: 0

## Recommended Next Actions

1. Fix `e2e/src/fake-agent.ts` to import `AgentSession` instead of `AgentThread` (S3-residual) — 1-line fix, eliminates latent type error.
2. Add `.min(1)` to `summary` and `message` in `reviewerResponseJsonSchemaSource` (S6) — 2-line fix, reduces avoidable repair turns.
3. Consider truncating the original prompt in `buildStructuredOutputRepairPrompt` (S1-residual) before the prescribed real-agent smoke run.
