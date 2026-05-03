import { parseArgs } from 'node:util';
import path from 'node:path';
import {
  loadSpecifyReplayFixtures,
  runSpecifyReplaySuite,
  type SpecifyReplayFixture,
  type SpecifyReplayResult,
  type SpecifyReplaySummary,
} from '../eval/specify-replay';

const USAGE = `orchestrator eval:specify

Usage:
  npm run eval:specify -- --fixtures <dir> [options]

Options:
  --fixtures <dir>    Directory containing fixture *.json files (required)
  --mode replay       Replay-only mode (default)
  --fixture <id>      Run only the fixture with this id (repeatable)
  --json              Emit machine-readable JSON to stdout instead of a table.
  --help              Show this message.

Exit codes:
  0  all selected fixtures passed (no unexpected parse/schema errors and no expectation mismatches)
  1  one or more failures
  64 usage error
`;

interface CliOptions {
  fixturesDir: string;
  fixtureIds: ReadonlyArray<string>;
  json: boolean;
  mode: 'replay';
}

export function parseEvalSpecifyCliArgs(argv: ReadonlyArray<string>): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fixtures: { type: 'string' },
      mode: { type: 'string', default: 'replay' },
      fixture: { type: 'string', multiple: true, default: [] },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (typeof values.fixtures !== 'string' || values.fixtures.length === 0) {
    process.stderr.write(USAGE);
    process.exit(64);
  }
  if (values.mode !== 'replay') {
    process.stderr.write(`invalid --mode "${String(values.mode)}" (Task 1 supports replay only)\n`);
    process.exit(64);
  }

  return {
    fixturesDir: path.resolve(values.fixtures),
    fixtureIds: Array.isArray(values.fixture) ? values.fixture : [],
    json: values.json === true,
    mode: 'replay',
  };
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const options = parseEvalSpecifyCliArgs(argv);
  const loadedFixtures = filterFixtures(await loadSpecifyReplayFixtures(options.fixturesDir), options.fixtureIds);
  if (loadedFixtures.length === 0) {
    process.stderr.write(`no fixtures found under ${options.fixturesDir}\n`);
    return 1;
  }

  const suite = runSpecifyReplaySuite(loadedFixtures);
  if (options.json) {
    process.stdout.write(JSON.stringify({ mode: options.mode, results: suite.results, summary: suite.summary }, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(suite.results, suite.summary));
  }

  const fixturesById = new Map(loadedFixtures.map((fixture) => [fixture.id, fixture]));
  const failed = suite.results.filter((result) => isFailureResult(result, fixturesById.get(result.id))).length;
  return failed > 0 ? 1 : 0;
}

function filterFixtures(fixtures: readonly SpecifyReplayFixture[], ids: ReadonlyArray<string>): SpecifyReplayFixture[] {
  if (ids.length === 0) {
    return [...fixtures];
  }
  const wanted = new Set(ids);
  const filtered = fixtures.filter((fixture) => wanted.has(fixture.id));
  const found = new Set(filtered.map((fixture) => fixture.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    process.stderr.write(`warning: fixture id(s) not found: ${missing.join(', ')}\n`);
  }
  return filtered;
}

function isFailureResult(result: SpecifyReplayResult, fixture: SpecifyReplayFixture | undefined): boolean {
  if (result.expectationMismatch) {
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

function renderText(results: readonly SpecifyReplayResult[], summary: SpecifyReplaySummary): string {
  const lines = ['Specify eval — replay mode', '─'.repeat(40)];
  for (const result of results) {
    const flag = result.expectationMismatch ? 'FAIL' : 'ok  ';
    const cost = `$${(result.costMicroUsd / 1_000_000).toFixed(4)}`;
    lines.push(`  ${flag}  ${result.id.padEnd(28)} status=${result.status.padEnd(13)} oq=${result.openQuestionsCount} cost=${cost}`);
    if (result.expectationMismatch) {
      lines.push(`        mismatch: ${result.expectationMismatch}`);
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