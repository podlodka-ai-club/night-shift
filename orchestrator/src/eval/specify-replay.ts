import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getAgentSchema } from '../agent-schema-registry';
import { parseSpecifyResponse } from '../phases/specify/response';

const specifyReplayStatusSchema = z.enum(['refined', 'needs_input', 'parse_error', 'schema_error']);
const recordedUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export const specifyReplayFixtureSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  ticket: z.object({
    title: z.string().min(1),
    description: z.string(),
    labels: z.array(z.string()).default([]),
  }).optional(),
  priorDraft: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  operatorComments: z.array(z.string()).default([]),
  finalResponse: z.string().optional(),
  recordedFinalText: z.string().optional(),
  recordedUsage: recordedUsageSchema.optional(),
  recordedCostMicroUsd: z.number().int().nonnegative().optional(),
  expected: z.object({
    status: specifyReplayStatusSchema.optional(),
    minOpenQuestions: z.number().int().nonnegative().optional(),
    maxOpenQuestions: z.number().int().nonnegative().optional(),
  }).optional(),
}).superRefine((fixture, ctx) => {
  if (fixture.finalResponse === undefined && fixture.recordedFinalText === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'fixture must include finalResponse or recordedFinalText',
      path: ['recordedFinalText'],
    });
  }
});

export const SPECIFY_REPLAY_SCHEMA_ID = 'specify-response-v1' as const;
// Fail fast if the replay harness points at a schema id that is no longer registered.
getAgentSchema(SPECIFY_REPLAY_SCHEMA_ID);

const ZERO_USAGE: SpecifyReplayRecordedUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};

export type SpecifyReplayEvalStatus = z.infer<typeof specifyReplayStatusSchema>;
export type SpecifyReplayRecordedUsage = z.infer<typeof recordedUsageSchema>;
export type SpecifyReplayFixture = z.infer<typeof specifyReplayFixtureSchema> & { fixturePath?: string };

export interface SpecifyReplayResult {
  id: string;
  status: SpecifyReplayEvalStatus;
  openQuestionsCount: number;
  assumptionsCount: number;
  risksCount: number;
  filesCount: number;
  costMicroUsd: number;
  totalTokens: number;
  errorMessage?: string;
  expectationMismatch?: string;
}

export interface SpecifyReplaySummary {
  total: number;
  byStatus: Record<SpecifyReplayEvalStatus, number>;
  totalCostMicroUsd: number;
  totalTokens: number;
  avgCostMicroUsd: number;
  expectationMismatches: number;
}

export interface SpecifyReplaySuiteResult {
  schemaId: typeof SPECIFY_REPLAY_SCHEMA_ID;
  results: SpecifyReplayResult[];
  summary: SpecifyReplaySummary;
}

export async function loadSpecifyReplayFixtures(fixturesDir: string): Promise<SpecifyReplayFixture[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const fixtureFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(fixtureFiles.map(async (entry) => {
    const fixturePath = path.join(fixturesDir, entry.name);
    const rawFixture = await readFile(fixturePath, 'utf8');
    return {
      ...specifyReplayFixtureSchema.parse(JSON.parse(rawFixture)),
      fixturePath,
    } satisfies SpecifyReplayFixture;
  }));
}

export function runSpecifyReplayFixture(fixture: SpecifyReplayFixture): SpecifyReplayResult {
  const finalText = fixture.recordedFinalText ?? fixture.finalResponse;
  const usage = fixture.recordedUsage ?? ZERO_USAGE;
  const costMicroUsd = fixture.recordedCostMicroUsd ?? 0;
  const totalTokens = usage.input_tokens + usage.output_tokens;

  if (typeof finalText !== 'string') {
    return buildReplayResult(fixture, 'parse_error', {
      costMicroUsd,
      totalTokens,
      errorMessage: 'fixture is missing recorded replay text',
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(finalText);
  } catch (error) {
    return buildReplayResult(fixture, 'parse_error', {
      costMicroUsd,
      totalTokens,
      errorMessage: `Response was not valid JSON: ${toErrorMessage(error)}`,
    });
  }

  try {
    const response = parseSpecifyResponse(parsedJson);
    return buildReplayResult(
      fixture,
      response.openQuestions.length === 0 ? 'refined' : 'needs_input',
      {
        openQuestionsCount: response.openQuestions.length,
        assumptionsCount: response.assumptions.length,
        risksCount: response.risks.length,
        filesCount: response.files.length,
        costMicroUsd,
        totalTokens,
      },
    );
  } catch (error) {
    return buildReplayResult(fixture, 'schema_error', {
      costMicroUsd,
      totalTokens,
      errorMessage: `Response did not match the expected schema: ${toErrorMessage(error)}`,
    });
  }
}

export function runSpecifyReplaySuite(fixtures: readonly SpecifyReplayFixture[]): SpecifyReplaySuiteResult {
  const results = fixtures.map((fixture) => runSpecifyReplayFixture(fixture));
  return {
    schemaId: SPECIFY_REPLAY_SCHEMA_ID,
    results,
    summary: summariseSpecifyReplayResults(results),
  };
}

export function summariseSpecifyReplayResults(results: readonly SpecifyReplayResult[]): SpecifyReplaySummary {
  const byStatus: SpecifyReplaySummary['byStatus'] = {
    refined: 0,
    needs_input: 0,
    parse_error: 0,
    schema_error: 0,
  };

  let totalCostMicroUsd = 0;
  let totalTokens = 0;
  let expectationMismatches = 0;
  for (const result of results) {
    byStatus[result.status] += 1;
    totalCostMicroUsd += result.costMicroUsd;
    totalTokens += result.totalTokens;
    if (result.expectationMismatch) {
      expectationMismatches += 1;
    }
  }

  return {
    total: results.length,
    byStatus,
    totalCostMicroUsd,
    totalTokens,
    avgCostMicroUsd: results.length === 0 ? 0 : Math.round(totalCostMicroUsd / results.length),
    expectationMismatches,
  };
}

function buildReplayResult(
  fixture: SpecifyReplayFixture,
  status: SpecifyReplayEvalStatus,
  extra: {
    openQuestionsCount?: number;
    assumptionsCount?: number;
    risksCount?: number;
    filesCount?: number;
    costMicroUsd: number;
    totalTokens: number;
    errorMessage?: string;
  },
): SpecifyReplayResult {
  const result: SpecifyReplayResult = {
    id: fixture.id,
    status,
    openQuestionsCount: extra.openQuestionsCount ?? 0,
    assumptionsCount: extra.assumptionsCount ?? 0,
    risksCount: extra.risksCount ?? 0,
    filesCount: extra.filesCount ?? 0,
    costMicroUsd: extra.costMicroUsd,
    totalTokens: extra.totalTokens,
    ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
  };

  const expectationMismatch = describeExpectationMismatch(fixture, result);
  return expectationMismatch === undefined ? result : { ...result, expectationMismatch };
}

function describeExpectationMismatch(
  fixture: SpecifyReplayFixture,
  result: SpecifyReplayResult,
): string | undefined {
  const expected = fixture.expected;
  if (!expected) {
    return undefined;
  }
  if (expected.status !== undefined && expected.status !== result.status) {
    return `expected status "${expected.status}", got "${result.status}"`;
  }
  if (expected.minOpenQuestions !== undefined && result.openQuestionsCount < expected.minOpenQuestions) {
    return `openQuestions ${result.openQuestionsCount} < min ${expected.minOpenQuestions}`;
  }
  if (expected.maxOpenQuestions !== undefined && result.openQuestionsCount > expected.maxOpenQuestions) {
    return `openQuestions ${result.openQuestionsCount} > max ${expected.maxOpenQuestions}`;
  }
  return undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}