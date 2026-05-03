import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getAgentSchema } from '../agent-schema-registry';
import { parseImplementResponse } from '../phases/implement/response';
import { recordedUsageSchema, toErrorMessage } from './replay-common';

const implementReplayStatusSchema = z.enum(['produced', 'empty', 'parse_error', 'schema_error']);

export const implementReplayFixtureSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  ticket: z.object({
    title: z.string().min(1),
    description: z.string(),
    labels: z.array(z.string()).default([]),
  }),
  specBundle: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
  operatorComments: z.array(z.string()).default([]),
  finalResponse: z.string().optional(),
  recordedFinalText: z.string().optional(),
  recordedUsage: recordedUsageSchema.optional(),
  recordedCostMicroUsd: z.number().int().nonnegative().optional(),
  expected: z.object({
    status: implementReplayStatusSchema.optional(),
    minFilesWritten: z.number().int().nonnegative().optional(),
    maxFilesWritten: z.number().int().nonnegative().optional(),
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

export const IMPLEMENT_REPLAY_SCHEMA_ID = 'implement-response-v1' as const;
// Fail fast if the replay harness points at a schema id that is no longer registered.
getAgentSchema(IMPLEMENT_REPLAY_SCHEMA_ID);

const ZERO_USAGE: ImplementReplayRecordedUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};

export type ImplementReplayEvalStatus = z.infer<typeof implementReplayStatusSchema>;
export type ImplementReplayRecordedUsage = z.infer<typeof recordedUsageSchema>;
export type ImplementReplayFixture = z.infer<typeof implementReplayFixtureSchema> & { fixturePath?: string };

export interface ImplementReplayResult {
  id: string;
  status: ImplementReplayEvalStatus;
  filesWrittenCount: number;
  totalContentChars: number;
  commitMessageLength: number;
  summaryLength: number;
  followUpsCount: number;
  costMicroUsd: number;
  totalTokens: number;
  errorMessage?: string;
  expectationMismatch?: string;
}

export interface ImplementReplaySummary {
  total: number;
  byStatus: Record<ImplementReplayEvalStatus, number>;
  totalCostMicroUsd: number;
  totalTokens: number;
  avgCostMicroUsd: number;
  expectationMismatches: number;
}

export interface ImplementReplaySuiteResult {
  schemaId: typeof IMPLEMENT_REPLAY_SCHEMA_ID;
  results: ImplementReplayResult[];
  summary: ImplementReplaySummary;
}

export async function loadImplementReplayFixtures(fixturesDir: string): Promise<ImplementReplayFixture[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const fixtureFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(fixtureFiles.map(async (entry) => {
    const fixturePath = path.join(fixturesDir, entry.name);
    const rawFixture = await readFile(fixturePath, 'utf8');
    return {
      ...implementReplayFixtureSchema.parse(JSON.parse(rawFixture)),
      fixturePath,
    } satisfies ImplementReplayFixture;
  }));
}

export function runImplementReplayFixture(fixture: ImplementReplayFixture): ImplementReplayResult {
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
    const response = parseImplementResponse(parsedJson);
    return buildReplayResult(
      fixture,
      response.filesWritten.length === 0 ? 'empty' : 'produced',
      {
        filesWrittenCount: response.filesWritten.length,
        totalContentChars: response.filesWritten.reduce((sum, file) => sum + file.content.length, 0),
        commitMessageLength: response.commitMessage.length,
        summaryLength: response.summary.length,
        followUpsCount: response.followUps.length,
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

export function runImplementReplaySuite(fixtures: readonly ImplementReplayFixture[]): ImplementReplaySuiteResult {
  const results = fixtures.map((fixture) => runImplementReplayFixture(fixture));
  return {
    schemaId: IMPLEMENT_REPLAY_SCHEMA_ID,
    results,
    summary: summariseImplementReplayResults(results),
  };
}

export function summariseImplementReplayResults(results: readonly ImplementReplayResult[]): ImplementReplaySummary {
  const byStatus: ImplementReplaySummary['byStatus'] = {
    produced: 0,
    empty: 0,
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
  fixture: ImplementReplayFixture,
  status: ImplementReplayEvalStatus,
  extra: {
    filesWrittenCount?: number;
    totalContentChars?: number;
    commitMessageLength?: number;
    summaryLength?: number;
    followUpsCount?: number;
    costMicroUsd: number;
    totalTokens: number;
    errorMessage?: string;
  },
): ImplementReplayResult {
  const result: ImplementReplayResult = {
    id: fixture.id,
    status,
    filesWrittenCount: extra.filesWrittenCount ?? 0,
    totalContentChars: extra.totalContentChars ?? 0,
    commitMessageLength: extra.commitMessageLength ?? 0,
    summaryLength: extra.summaryLength ?? 0,
    followUpsCount: extra.followUpsCount ?? 0,
    costMicroUsd: extra.costMicroUsd,
    totalTokens: extra.totalTokens,
    ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
  };

  const expectationMismatch = describeExpectationMismatch(fixture, result);
  return expectationMismatch === undefined ? result : { ...result, expectationMismatch };
}

function describeExpectationMismatch(
  fixture: ImplementReplayFixture,
  result: ImplementReplayResult,
): string | undefined {
  const expected = fixture.expected;
  if (!expected) {
    return undefined;
  }
  if (expected.status !== undefined && expected.status !== result.status) {
    return `expected status "${expected.status}", got "${result.status}"`;
  }
  if (expected.minFilesWritten !== undefined && result.filesWrittenCount < expected.minFilesWritten) {
    return `filesWritten ${result.filesWrittenCount} < min ${expected.minFilesWritten}`;
  }
  if (expected.maxFilesWritten !== undefined && result.filesWrittenCount > expected.maxFilesWritten) {
    return `filesWritten ${result.filesWrittenCount} > max ${expected.maxFilesWritten}`;
  }
  return undefined;
}
