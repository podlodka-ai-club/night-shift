import { parseResponse } from "../phases/specify/parse.js";
import { SpecifyAgentError } from "../phases/specify/errors.js";
import type {
  SpecifyEvalFixture,
  SpecifyEvalResult,
  SpecifyEvalSummary,
} from "./types.js";

/**
 * A pluggable runner that produces a single agent turn's output for one
 * fixture. Replay implementations return the fixture's `recordedFinalText`
 * (and recorded usage); live implementations call the real adapter.
 *
 * Keeping this an interface lets the harness stay free of any agent / network
 * dependency — fixtures, parsing, and metrics are pure. Live wiring lives in
 * the CLI layer.
 */
export interface SpecifyTurnRunner {
  run(fixture: SpecifyEvalFixture): Promise<{
    finalText: string;
    usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
    costMicroUsd: number;
  }>;
}

/**
 * Replay runner: serves recorded final text from each fixture. Throws when a
 * fixture is missing `recordedFinalText` so the failure mode is loud rather
 * than silently zero-cost.
 */
export const replayRunner: SpecifyTurnRunner = {
  async run(fixture) {
    if (typeof fixture.recordedFinalText !== "string") {
      throw new Error(`fixture "${fixture.id}" has no recordedFinalText (replay mode requires it)`);
    }
    const usage = fixture.recordedUsage ?? {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    };
    return {
      finalText: fixture.recordedFinalText,
      usage,
      costMicroUsd: fixture.recordedCostMicroUsd ?? 0,
    };
  },
};

export async function evaluateSpecifyFixture(
  fixture: SpecifyEvalFixture,
  runner: SpecifyTurnRunner,
): Promise<SpecifyEvalResult> {
  const turn = await runner.run(fixture);
  const totalTokens = turn.usage.input_tokens + turn.usage.output_tokens;

  let parsed: ReturnType<typeof parseResponse> | undefined;
  let errorStatus: SpecifyEvalResult["status"] | undefined;
  let errorMessage: string | undefined;

  try {
    parsed = parseResponse(turn.finalText, { ticketId: fixture.id });
  } catch (err) {
    if (err instanceof SpecifyAgentError) {
      errorStatus = err.code === "parse" ? "parse_error" : "schema_error";
    } else {
      errorStatus = "parse_error";
    }
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (errorStatus !== undefined || parsed === undefined) {
    return {
      id: fixture.id,
      status: errorStatus ?? "parse_error",
      openQuestionsCount: 0,
      assumptionsCount: 0,
      risksCount: 0,
      filesCount: 0,
      costMicroUsd: turn.costMicroUsd,
      totalTokens,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  const status: "refined" | "needs_input" =
    parsed.openQuestions.length > 0 ? "needs_input" : "refined";

  const result: SpecifyEvalResult = {
    id: fixture.id,
    status,
    openQuestionsCount: parsed.openQuestions.length,
    assumptionsCount: parsed.assumptions.length,
    risksCount: parsed.risks.length,
    filesCount: parsed.files.length,
    costMicroUsd: turn.costMicroUsd,
    totalTokens,
  };

  const mismatch = compareExpectation(fixture, result);
  if (mismatch) result.expectationMismatch = mismatch;

  return result;
}

function compareExpectation(
  fixture: SpecifyEvalFixture,
  result: SpecifyEvalResult,
): string | undefined {
  const exp = fixture.expected;
  if (!exp) return undefined;
  if (exp.status !== undefined && exp.status !== result.status) {
    return `expected status "${exp.status}", got "${result.status}"`;
  }
  if (
    exp.minOpenQuestions !== undefined &&
    result.openQuestionsCount < exp.minOpenQuestions
  ) {
    return `openQuestions ${result.openQuestionsCount} < min ${exp.minOpenQuestions}`;
  }
  if (
    exp.maxOpenQuestions !== undefined &&
    result.openQuestionsCount > exp.maxOpenQuestions
  ) {
    return `openQuestions ${result.openQuestionsCount} > max ${exp.maxOpenQuestions}`;
  }
  return undefined;
}

export async function evaluateSpecifySuite(
  fixtures: ReadonlyArray<SpecifyEvalFixture>,
  runner: SpecifyTurnRunner,
): Promise<{ results: SpecifyEvalResult[]; summary: SpecifyEvalSummary }> {
  const results: SpecifyEvalResult[] = [];
  for (const fixture of fixtures) {
    results.push(await evaluateSpecifyFixture(fixture, runner));
  }
  return { results, summary: summarise(results) };
}

export function summarise(results: ReadonlyArray<SpecifyEvalResult>): SpecifyEvalSummary {
  const byStatus: SpecifyEvalSummary["byStatus"] = {
    refined: 0,
    needs_input: 0,
    parse_error: 0,
    schema_error: 0,
  };
  let totalCostMicroUsd = 0;
  let totalTokens = 0;
  let expectationMismatches = 0;
  for (const r of results) {
    byStatus[r.status]++;
    totalCostMicroUsd += r.costMicroUsd;
    totalTokens += r.totalTokens;
    if (r.expectationMismatch) expectationMismatches++;
  }
  const total = results.length;
  return {
    total,
    byStatus,
    totalCostMicroUsd,
    totalTokens,
    avgCostMicroUsd: total > 0 ? Math.round(totalCostMicroUsd / total) : 0,
    expectationMismatches,
  };
}
