import { parseArgs } from 'node:util';
import path from 'node:path';
import { hasJudgeFailure, MAX_LIVE_JUDGE_REVISIONS } from '../eval/live-judge';
import {
  loadSpecifyReplayFixtures,
  runSpecifyReplaySuite,
  type SpecifyReplayFixture,
  type SpecifyReplayResult,
  type SpecifyReplaySummary,
} from '../eval/specify-replay';
import { runSpecifyLiveSuite } from '../eval/specify-live';

const USAGE = `orchestrator eval:specify

Usage:
  npm run eval:specify -- --fixtures <dir> [options]

Options:
  --fixtures <dir>    Directory containing fixture *.json files (required)
  --mode <mode>       replay (default) or live
  --worktree <dir>    Repository/worktree path for live mode (default: current working directory)
  --timeout-ms <n>    Live-mode timeout per fixture in milliseconds (default: 300000)
  --judge             Run an additional judge pass in live mode
  --max-revisions <n> Live-mode judge revisions to allow per fixture (default: 0, max: 2)
  --fixture <id>      Run only the fixture with this id (repeatable)
  --json              Emit machine-readable JSON to stdout instead of a table.
  --help              Show this message.

Notes:
  Live mode reuses a single writable worktree across selected fixtures.
  Prefer disposable worktrees or single-fixture runs to avoid cross-fixture contamination.

Exit codes:
  0  all selected fixtures passed (no unexpected parse/schema errors, expectation mismatches, or judge revise/error failures)
  1  one or more failures
  64 usage error
`;

type CliOptions = {
  fixturesDir: string;
  fixtureIds: ReadonlyArray<string>;
  json: boolean;
} & (
  | { mode: 'replay' }
  | { mode: 'live'; worktreePath: string; timeoutMs: number; judge?: { maxRevisions: number } }
);

interface Writer {
  write: (chunk: string) => unknown;
}

export interface EvalSpecifyCliDeps {
  loadFixtures: typeof loadSpecifyReplayFixtures;
  runReplaySuite: typeof runSpecifyReplaySuite;
  runLiveSuite: typeof runSpecifyLiveSuite;
  stdout: Writer;
  stderr: Writer;
}

const DEFAULT_DEPS: EvalSpecifyCliDeps = {
  loadFixtures: loadSpecifyReplayFixtures,
  runReplaySuite: runSpecifyReplaySuite,
  runLiveSuite: runSpecifyLiveSuite,
  stdout: process.stdout,
  stderr: process.stderr,
};

const DEFAULT_LIVE_TIMEOUT_MS = 300_000;
const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

class EvalSpecifyCliUsageError extends Error {
  constructor(
    readonly exitCode: number,
    readonly output: string,
    readonly destination: 'stdout' | 'stderr',
  ) {
    super(output);
    this.name = 'EvalSpecifyCliUsageError';
  }
}

export function parseEvalSpecifyCliArgs(argv: ReadonlyArray<string>): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fixtures: { type: 'string' },
      mode: { type: 'string', default: 'replay' },
      worktree: { type: 'string' },
      'timeout-ms': { type: 'string' },
      judge: { type: 'boolean', default: false },
      'max-revisions': { type: 'string' },
      fixture: { type: 'string', multiple: true, default: [] },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    throw new EvalSpecifyCliUsageError(0, USAGE, 'stdout');
  }
  if (typeof values.fixtures !== 'string' || values.fixtures.length === 0) {
    throw new EvalSpecifyCliUsageError(64, USAGE, 'stderr');
  }
  if (values.mode !== 'replay' && values.mode !== 'live') {
    throw new EvalSpecifyCliUsageError(64, `invalid --mode "${String(values.mode)}" (expected replay or live)\n`, 'stderr');
  }

  const baseOptions = {
    fixturesDir: path.resolve(values.fixtures),
    fixtureIds: Array.isArray(values.fixture) ? values.fixture : [],
    json: values.json === true,
  };

  if (values.mode === 'live') {
    const timeoutMs = parseTimeoutMs(values['timeout-ms']);
    const judge = parseJudgeOptions(values.judge === true, values['max-revisions']);
    return {
      ...baseOptions,
      mode: 'live',
      worktreePath: path.resolve(values.worktree ?? process.cwd()),
      timeoutMs,
      ...(judge ? { judge } : {}),
    };
  }

  const liveOnlyFlags = [
    values.judge === true ? '--judge' : undefined,
    values['max-revisions'] !== undefined ? '--max-revisions' : undefined,
    values.worktree !== undefined ? '--worktree' : undefined,
    values['timeout-ms'] !== undefined ? '--timeout-ms' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (liveOnlyFlags.length > 0) {
    throw new EvalSpecifyCliUsageError(64, `${liveOnlyFlags.join(', ')} ${liveOnlyFlags.length === 1 ? 'is' : 'are'} only supported in live mode\n`, 'stderr');
  }

  return {
    ...baseOptions,
    mode: 'replay',
  };
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2), deps: EvalSpecifyCliDeps = DEFAULT_DEPS): Promise<number> {
  let options: CliOptions;
  try {
    options = parseEvalSpecifyCliArgs(argv);
  } catch (error) {
    if (error instanceof EvalSpecifyCliUsageError) {
      deps[error.destination].write(error.output);
      return error.exitCode;
    }
    throw error;
  }

  const loadedFixtures = filterFixtures(await deps.loadFixtures(options.fixturesDir), options.fixtureIds, deps.stderr);
  if (loadedFixtures.length === 0) {
    deps.stderr.write(`no fixtures found under ${options.fixturesDir}\n`);
    return 1;
  }

  const suite = options.mode === 'live'
    ? await deps.runLiveSuite(loadedFixtures, {
      worktreePath: options.worktreePath,
      timeoutMs: options.timeoutMs,
      ...(options.judge ? { judge: options.judge } : {}),
    })
    : deps.runReplaySuite(loadedFixtures);
  if (options.json) {
    deps.stdout.write(JSON.stringify({
      mode: options.mode,
      results: suite.results,
      summary: suite.summary,
      ...(suite.judgeSummary ? { judgeSummary: suite.judgeSummary } : {}),
    }, null, 2) + '\n');
  } else {
    deps.stdout.write(renderText(options.mode, suite.results, suite.summary, suite.judgeSummary));
  }

  const fixturesById = new Map(loadedFixtures.map((fixture) => [fixture.id, fixture]));
  const failed = suite.results.filter((result) => isFailureResult(result, fixturesById.get(result.id))).length;
  return failed > 0 ? 1 : 0;
}

function filterFixtures(fixtures: readonly SpecifyReplayFixture[], ids: ReadonlyArray<string>, stderr: Writer): SpecifyReplayFixture[] {
  if (ids.length === 0) {
    return [...fixtures];
  }
  const wanted = new Set(ids);
  const filtered = fixtures.filter((fixture) => wanted.has(fixture.id));
  const found = new Set(filtered.map((fixture) => fixture.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    stderr.write(`warning: fixture id(s) not found: ${missing.join(', ')}\n`);
  }
  return filtered;
}

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIVE_TIMEOUT_MS;
  }

  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new EvalSpecifyCliUsageError(64, `invalid --timeout-ms "${value}" (expected a positive integer)\n`, 'stderr');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EvalSpecifyCliUsageError(64, `invalid --timeout-ms "${value}" (expected a positive integer)\n`, 'stderr');
  }
  return parsed;
}

function parseJudgeOptions(enabled: boolean, maxRevisionsValue: string | undefined): { maxRevisions: number } | undefined {
  if (!enabled && maxRevisionsValue === undefined) {
    return undefined;
  }
  if (!enabled) {
    throw new EvalSpecifyCliUsageError(64, '--max-revisions requires --judge\n', 'stderr');
  }

  const maxRevisions = parseNonNegativeInt(maxRevisionsValue ?? '0', '--max-revisions');
  if (maxRevisions > MAX_LIVE_JUDGE_REVISIONS) {
    throw new EvalSpecifyCliUsageError(64, `--max-revisions must be <= ${MAX_LIVE_JUDGE_REVISIONS}\n`, 'stderr');
  }
  return { maxRevisions };
}

function parseNonNegativeInt(value: string, flag: string): number {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    throw new EvalSpecifyCliUsageError(64, `invalid ${flag} "${value}" (expected a non-negative integer)\n`, 'stderr');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EvalSpecifyCliUsageError(64, `invalid ${flag} "${value}" (expected a non-negative integer)\n`, 'stderr');
  }
  return parsed;
}

function isFailureResult(result: SpecifyReplayResult, fixture: SpecifyReplayFixture | undefined): boolean {
  if (result.expectationMismatch) {
    return true;
  }
  if (hasJudgeFailure(result)) {
    return true;
  }
  if (result.status === 'parse_error' || result.status === 'schema_error') {
    // Replay fixtures intentionally include expected parse/schema failures so the suite can regression-test
    // negative cases without treating them as CLI failures.
    return fixture?.expected?.status !== result.status;
  }
  return false;
}

function isDirectCliExecution(argv: ReadonlyArray<string> = process.argv): boolean {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return false;
  }

  const normalizedEntrypoint = path.normalize(entrypoint);
  return [
    path.join('src', 'cli', 'eval-specify.ts'),
    path.join('lib', 'cli', 'eval-specify.js'),
  ].some((suffix) => normalizedEntrypoint.endsWith(suffix));
}

function renderText(
  mode: CliOptions['mode'],
  results: readonly SpecifyReplayResult[],
  summary: SpecifyReplaySummary,
  judgeSummary?: { byVerdict: Record<'pass' | 'revise' | 'error', number>; totalJudgeCostMicroUsd: number; totalJudgeTokens: number; totalRevisions: number },
): string {
  const lines = [`Specify eval — ${mode} mode`, '─'.repeat(40)];
  for (const result of results) {
    const flag = result.expectationMismatch || hasJudgeFailure(result) ? 'FAIL' : 'ok  ';
    const cost = `$${(result.costMicroUsd / 1_000_000).toFixed(4)}`;
    const judgeLabel = result.judge ? ` judge=${result.judge.finalVerdict}` : '';
    lines.push(`  ${flag}  ${result.id.padEnd(28)} status=${result.status.padEnd(13)} oq=${result.openQuestionsCount} cost=${cost}${judgeLabel}`);
    if (result.expectationMismatch) {
      lines.push(`        mismatch: ${result.expectationMismatch}`);
    }
    if ((result.status === 'parse_error' || result.status === 'schema_error') && result.errorMessage) {
      lines.push(`        error: ${result.errorMessage}`);
    }
    const latestJudgeAttempt = result.judge?.attempts[result.judge.attempts.length - 1];
    if (latestJudgeAttempt?.summary) {
      lines.push(`        judge: ${latestJudgeAttempt.summary}`);
    }
    if (latestJudgeAttempt?.errorMessage) {
      lines.push(`        judge-error: ${latestJudgeAttempt.errorMessage}`);
    }
  }
  lines.push('─'.repeat(40));
  lines.push(`  total:                ${summary.total}`);
  lines.push(`  refined:              ${summary.byStatus.refined}`);
  lines.push(`  needs_input:          ${summary.byStatus.needs_input}`);
  lines.push(`  parse_error:          ${summary.byStatus.parse_error}`);
  lines.push(`  schema_error:         ${summary.byStatus.schema_error}`);
  lines.push(`  expectationMismatches:${summary.expectationMismatches}`);
  lines.push(`  totalCost:            $${(summary.totalCostMicroUsd / 1_000_000).toFixed(4)}`);
  lines.push(`  totalTokens:          ${summary.totalTokens}`);
  if (judgeSummary) {
    lines.push(`  judge.pass:           ${judgeSummary.byVerdict.pass}`);
    lines.push(`  judge.revise:         ${judgeSummary.byVerdict.revise}`);
    lines.push(`  judge.error:          ${judgeSummary.byVerdict.error}`);
    lines.push(`  judge.totalCost:      $${(judgeSummary.totalJudgeCostMicroUsd / 1_000_000).toFixed(4)}`);
    lines.push(`  judge.totalTokens:    ${judgeSummary.totalJudgeTokens}`);
    lines.push(`  judge.totalRevisions: ${judgeSummary.totalRevisions}`);
  }
  return `${lines.join('\n')}\n`;
}

if (isDirectCliExecution()) {
  main().then(
    (exitCode) => process.exit(exitCode),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}