import { parseImplementerResponse } from "../phases/implement/parse.js";
import { ImplementAgentError } from "../phases/implement/errors.js";
import type {
  ImplementEvalFixture,
  ImplementEvalResult,
  ImplementEvalSummary,
} from "./types.js";

/**
 * Pluggable runner that produces a single implementer turn's output for one
 * fixture. Replay reads `recordedFinalText`; live calls a real adapter.
 *
 * Mirrors `SpecifyTurnRunner`: keeping it an interface lets the harness stay
 * network-free, with all live wiring in the CLI layer.
 */
export interface ImplementTurnRunner {
  run(fixture: ImplementEvalFixture): Promise<{
    finalText: string;
    usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
    costMicroUsd: number;
  }>;
}

export const implementReplayRunner: ImplementTurnRunner = {
  async run(fixture) {
    if (typeof fixture.recordedFinalText !== "string") {
      throw new Error(
        `fixture "${fixture.id}" has no recordedFinalText (replay mode requires it)`,
      );
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

export async function evaluateImplementFixture(
  fixture: ImplementEvalFixture,
  runner: ImplementTurnRunner,
): Promise<ImplementEvalResult> {
  const turn = await runner.run(fixture);
  const totalTokens = turn.usage.input_tokens + turn.usage.output_tokens;

  let parsed: ReturnType<typeof parseImplementerResponse> | undefined;
  let errorStatus: ImplementEvalResult["status"] | undefined;
  let errorMessage: string | undefined;

  try {
    parsed = parseImplementerResponse(turn.finalText, { ticketId: fixture.id });
  } catch (err) {
    if (err instanceof ImplementAgentError) {
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
      filesWrittenCount: 0,
      totalContentChars: 0,
      commitMessageLength: 0,
      summaryLength: 0,
      followUpsCount: 0,
      costMicroUsd: turn.costMicroUsd,
      totalTokens,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  const status: "produced" | "empty" =
    parsed.filesWritten.length > 0 ? "produced" : "empty";
  const totalContentChars = parsed.filesWritten.reduce(
    (sum, f) => sum + f.content.length,
    0,
  );

  const result: ImplementEvalResult = {
    id: fixture.id,
    status,
    filesWrittenCount: parsed.filesWritten.length,
    totalContentChars,
    commitMessageLength: parsed.commitMessage.length,
    summaryLength: parsed.summary.length,
    followUpsCount: parsed.followUps.length,
    costMicroUsd: turn.costMicroUsd,
    totalTokens,
  };

  const mismatch = compareExpectation(fixture, result);
  if (mismatch) result.expectationMismatch = mismatch;

  return result;
}

function compareExpectation(
  fixture: ImplementEvalFixture,
  result: ImplementEvalResult,
): string | undefined {
  const exp = fixture.expected;
  if (!exp) return undefined;
  if (exp.status !== undefined && exp.status !== result.status) {
    return `expected status "${exp.status}", got "${result.status}"`;
  }
  if (
    exp.minFilesWritten !== undefined &&
    result.filesWrittenCount < exp.minFilesWritten
  ) {
    return `filesWritten ${result.filesWrittenCount} < min ${exp.minFilesWritten}`;
  }
  if (
    exp.maxFilesWritten !== undefined &&
    result.filesWrittenCount > exp.maxFilesWritten
  ) {
    return `filesWritten ${result.filesWrittenCount} > max ${exp.maxFilesWritten}`;
  }
  return undefined;
}

export async function evaluateImplementSuite(
  fixtures: ReadonlyArray<ImplementEvalFixture>,
  runner: ImplementTurnRunner,
): Promise<{ results: ImplementEvalResult[]; summary: ImplementEvalSummary }> {
  const results: ImplementEvalResult[] = [];
  for (const fixture of fixtures) {
    results.push(await evaluateImplementFixture(fixture, runner));
  }
  return { results, summary: summariseImplement(results) };
}

export function summariseImplement(
  results: ReadonlyArray<ImplementEvalResult>,
): ImplementEvalSummary {
  const byStatus: ImplementEvalSummary["byStatus"] = {
    produced: 0,
    empty: 0,
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
