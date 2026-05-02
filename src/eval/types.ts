import { z } from "zod";

/**
 * A single specifier eval fixture: one ticket and the context the specifier
 * would normally read from GitHub / the worktree, plus optional ground-truth
 * expectations to compare against.
 *
 * Replay mode: when `recordedFinalText` is present, the harness skips the LLM
 * call entirely and feeds the recorded text through the real `parseResponse`
 * pipeline. This makes regression runs deterministic and free.
 *
 * Live mode: `recordedFinalText` is absent; the caller wires a real adapter.
 * The harness can serialise the live result back into a fixture so future
 * runs can be replayed.
 */
export const SpecifyEvalFixtureSchema = z.object({
  id: z.string().min(1),
  ticket: z.object({
    title: z.string().min(1),
    description: z.string(),
    labels: z.array(z.string()).default([]),
  }),
  /**
   * Optional pre-existing draft files on the change branch. Mirrors
   * `PriorDraftFile[]` but with a relaxed shape so fixtures can be authored
   * without pulling phase-internal types.
   */
  priorDraft: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .default([]),
  /** Optional operator comments on the issue. */
  operatorComments: z.array(z.string()).default([]),
  /** Replay-mode payload: the agent's final JSON text. */
  recordedFinalText: z.string().optional(),
  /** Replay-mode usage echo, used for cost accounting. */
  recordedUsage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      cached_input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  /** Replay-mode cost in micro-USD. */
  recordedCostMicroUsd: z.number().int().nonnegative().optional(),
  /** Optional ground truth for assertion-style runs. */
  expected: z
    .object({
      status: z.enum(["refined", "needs_input", "parse_error", "schema_error"]).optional(),
      minOpenQuestions: z.number().int().nonnegative().optional(),
      maxOpenQuestions: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type SpecifyEvalFixture = z.infer<typeof SpecifyEvalFixtureSchema>;

export const SpecifyEvalResultSchema = z.object({
  id: z.string(),
  /** Final phase status as derived from the parsed response. */
  status: z.enum(["refined", "needs_input", "parse_error", "schema_error"]),
  openQuestionsCount: z.number().int().nonnegative(),
  assumptionsCount: z.number().int().nonnegative(),
  risksCount: z.number().int().nonnegative(),
  filesCount: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Populated when status is parse_error/schema_error. */
  errorMessage: z.string().optional(),
  /** Populated when fixture.expected was set; surfaces mismatches. */
  expectationMismatch: z.string().optional(),
});
export type SpecifyEvalResult = z.infer<typeof SpecifyEvalResultSchema>;

export interface SpecifyEvalSummary {
  total: number;
  byStatus: Record<SpecifyEvalResult["status"], number>;
  totalCostMicroUsd: number;
  totalTokens: number;
  avgCostMicroUsd: number;
  expectationMismatches: number;
}

/**
 * Implementer eval fixture: ticket + spec bundle the implementer would
 * normally read off the change branch, plus optional comments and ground
 * truth. The fixture stays "shape-only" — we never run the produced patch,
 * we just check the JSON contract holds and the response shape looks
 * sensible.
 */
export const ImplementEvalFixtureSchema = z.object({
  id: z.string().min(1),
  ticket: z.object({
    title: z.string().min(1),
    description: z.string(),
    labels: z.array(z.string()).default([]),
  }),
  /**
   * The spec bundle (`proposal.md`, `tasks.md`, optional `design.md` and
   * `specs/<capability>/spec.md`) the implementer reads. Authored as plain
   * `{path, content}` pairs so fixtures can be checked into the repo without
   * depending on phase-internal types.
   */
  specBundle: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .min(1),
  operatorComments: z.array(z.string()).default([]),
  /** Replay-mode payload: the agent's final JSON text. */
  recordedFinalText: z.string().optional(),
  recordedUsage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      cached_input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  recordedCostMicroUsd: z.number().int().nonnegative().optional(),
  expected: z
    .object({
      status: z.enum(["produced", "empty", "parse_error", "schema_error"]).optional(),
      minFilesWritten: z.number().int().nonnegative().optional(),
      maxFilesWritten: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type ImplementEvalFixture = z.infer<typeof ImplementEvalFixtureSchema>;

export const ImplementEvalResultSchema = z.object({
  id: z.string(),
  status: z.enum(["produced", "empty", "parse_error", "schema_error"]),
  filesWrittenCount: z.number().int().nonnegative(),
  totalContentChars: z.number().int().nonnegative(),
  commitMessageLength: z.number().int().nonnegative(),
  summaryLength: z.number().int().nonnegative(),
  followUpsCount: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
  expectationMismatch: z.string().optional(),
});
export type ImplementEvalResult = z.infer<typeof ImplementEvalResultSchema>;

export interface ImplementEvalSummary {
  total: number;
  byStatus: Record<ImplementEvalResult["status"], number>;
  totalCostMicroUsd: number;
  totalTokens: number;
  avgCostMicroUsd: number;
  expectationMismatches: number;
}
