import assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'mocha';
import { main, parseEvalSpecifyCliArgs } from '../cli/eval-specify';
import { loadSpecifyReplayFixtures } from '../eval/specify-replay';

const orchestratorRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(orchestratorRoot, 'src', 'cli', 'eval-specify.ts');
const fixturesDir = path.join(orchestratorRoot, 'eval', 'fixtures', 'specify');

describe('specify eval cli', function () {
  this.timeout(5_000);

  it('emits donor-like JSON output and supports fixture filtering in replay mode', async () => {
    const result = await runCli(['--fixtures', fixturesDir, '--fixture', 'refined-bug-fix', '--json']);

    assert.strictEqual(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as any;
    assert.strictEqual(parsed.mode, 'replay');
    assert.strictEqual(parsed.results.length, 1);
    assert.strictEqual(parsed.results[0]?.id, 'refined-bug-fix');
    assert.strictEqual(parsed.results[0]?.status, 'refined');
    assert.strictEqual(parsed.summary.total, 1);
    assert.deepStrictEqual(parsed.summary.byStatus, {
      refined: 1,
      needs_input: 0,
      parse_error: 0,
      schema_error: 0,
    });
  });

  it('returns exit code 1 when replay expectations mismatch', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'specify-replay-cli-'));
    try {
      await writeFile(path.join(tempDir, 'mismatch.json'), JSON.stringify({
        id: 'cli-mismatch',
        ticket: { title: 'Mismatch', description: 'Synthetic fixture for CLI exit-code coverage.' },
        recordedFinalText: JSON.stringify({
          files: [
            { path: 'proposal.md', content: '# Proposal' },
            { path: 'tasks.md', content: '- [ ] Follow up' },
          ],
          openQuestions: ['Need operator input'],
          assumptions: [],
          risks: [],
        }),
        expected: { status: 'refined' },
      }, null, 2), 'utf8');

      const result = await runCli(['--fixtures', tempDir, '--json']);
      assert.strictEqual(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout) as any;
      assert.strictEqual(parsed.summary.expectationMismatches, 1);
      assert.match(parsed.results[0]?.expectationMismatch ?? '', /expected status/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses live mode with an explicit worktree path', () => {
    const parsed = parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--fixture', 'refined-bug-fix']);

    assert.deepStrictEqual(parsed, {
      fixturesDir: path.resolve(fixturesDir),
      fixtureIds: ['refined-bug-fix'],
      json: false,
      mode: 'live',
      worktreePath: path.resolve('/tmp/live-repo'),
      timeoutMs: 300000,
      provider: 'codex',
      model: 'gpt-5.3-codex',
      record: false,
    });
  });

  it('parses provider/model recording flags in live mode and rejects unsupported combinations', () => {
    const parsed = parseEvalSpecifyCliArgs([
      '--fixtures', fixturesDir,
      '--mode', 'live',
      '--worktree', '/tmp/live-repo',
      '--provider', 'claude',
      '--model', 'claude-sonnet-4-6',
      '--record',
    ]) as any;

    assert.deepStrictEqual(parsed, {
      fixturesDir: path.resolve(fixturesDir),
      fixtureIds: [],
      json: false,
      mode: 'live',
      worktreePath: path.resolve('/tmp/live-repo'),
      timeoutMs: 300000,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      record: true,
    });

    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--provider', 'claude']),
      /live mode/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--record']),
      /requires --mode live/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--record', '--judge']),
      /--record.*--judge/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--provider', 'claude', '--model', 'gpt-5.3-codex']),
      /does not match provider/i,
    );
  });

  it('parses optional judge flags for live mode and rejects them in replay mode', () => {
    const parsed = parseEvalSpecifyCliArgs([
      '--fixtures', fixturesDir,
      '--mode', 'live',
      '--worktree', '/tmp/live-repo',
      '--judge',
      '--max-revisions', '1',
    ]) as any;

    assert.deepStrictEqual(parsed, {
      fixturesDir: path.resolve(fixturesDir),
      fixtureIds: [],
      json: false,
      mode: 'live',
      worktreePath: path.resolve('/tmp/live-repo'),
      timeoutMs: 300000,
      provider: 'codex',
      model: 'gpt-5.3-codex',
      record: false,
      judge: { maxRevisions: 1 },
    });

    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--judge']),
      /live mode/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--worktree', '/tmp/live-repo']),
      /live mode/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--timeout-ms', '5000']),
      /live mode/i,
    );
  });

  it('rejects malformed numeric inputs instead of truncating them', () => {
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--timeout-ms', '1foo']),
      /positive integer/i,
    );
    assert.throws(
      () => parseEvalSpecifyCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--judge', '--max-revisions', '1.5']),
      /non-negative integer/i,
    );
  });

  it('dispatches live mode through the live suite and preserves the CLI JSON shape', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--provider', 'claude', '--model', 'claude-sonnet-4-6', '--json'],
      {
        loadFixtures: async () => [{ id: 'live-specify' } as any],
        runReplaySuite: () => {
          throw new Error('replay suite should not run in live mode');
        },
        runLiveSuite: async (_fixtures, options) => {
          assert.strictEqual(options.worktreePath, path.resolve('/tmp/live-repo'));
          assert.strictEqual(options.timeoutMs, 300000);
          assert.strictEqual((options as any).provider, 'claude');
          assert.strictEqual((options as any).model, 'claude-sonnet-4-6');
          return {
            schemaId: 'specify-response-v1',
            results: [{
              id: 'live-specify',
              status: 'refined',
              openQuestionsCount: 0,
              assumptionsCount: 1,
              risksCount: 0,
              filesCount: 2,
              costMicroUsd: 0,
              totalTokens: 42,
            }],
            summary: {
              total: 1,
              byStatus: { refined: 1, needs_input: 0, parse_error: 0, schema_error: 0 },
              totalCostMicroUsd: 0,
              totalTokens: 42,
              avgCostMicroUsd: 0,
              expectationMismatches: 0,
            },
          } as any;
        },
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: () => true },
      },
    );

    assert.strictEqual(exitCode, 0);
    const parsed = JSON.parse(stdout) as any;
    assert.strictEqual(parsed.mode, 'live');
    assert.strictEqual(parsed.results[0]?.id, 'live-specify');
    assert.strictEqual(parsed.summary.total, 1);
  });

  it('records only selected successful live fixtures back into their source files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'specify-live-record-'));
    const successPath = path.join(tempDir, 'record-me.json');
    const parseErrorPath = path.join(tempDir, 'parse-error.json');
    const untouchedPath = path.join(tempDir, 'untouched.json');
    try {
      await writeFile(successPath, JSON.stringify({
        id: 'record-me',
        ticket: { title: 'Record successful live output', description: 'Persist the selected fixture only.' },
        priorDraft: [],
        operatorComments: [],
        finalResponse: JSON.stringify({ files: [{ path: 'proposal.md', content: '# Old' }], openQuestions: [], assumptions: [], risks: [] }),
        expected: { status: 'refined' },
      }, null, 2), 'utf8');
      await writeFile(parseErrorPath, JSON.stringify({
        id: 'parse-error',
        ticket: { title: 'Do not record failed live output', description: 'Leave parse-error fixtures unchanged.' },
        priorDraft: [],
        operatorComments: [],
        finalResponse: JSON.stringify({ files: [{ path: 'proposal.md', content: '# Old parse error' }], openQuestions: [], assumptions: [], risks: [] }),
        expected: { status: 'parse_error' },
      }, null, 2), 'utf8');
      await writeFile(untouchedPath, JSON.stringify({
        id: 'untouched',
        ticket: { title: 'Unselected fixture', description: 'Should not be rewritten.' },
        priorDraft: [],
        operatorComments: [],
        finalResponse: JSON.stringify({ files: [{ path: 'proposal.md', content: '# Untouched' }], openQuestions: [], assumptions: [], risks: [] }),
        expected: { status: 'refined' },
      }, null, 2), 'utf8');

      const exitCode = await main(
        ['--fixtures', tempDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--fixture', 'record-me', '--fixture', 'parse-error', '--record'],
        {
          loadFixtures: loadSpecifyReplayFixtures,
          runReplaySuite: () => {
            throw new Error('replay suite should not run in live mode');
          },
          runLiveSuite: async (fixtures, options) => {
            assert.deepStrictEqual(fixtures.map((fixture) => fixture.id), ['parse-error', 'record-me']);
            (options as any).onGeneratorResult?.(fixtures[0], {
              finalText: '{invalid-json',
              usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 1 },
              costMicroUsd: 20,
            });
            (options as any).onGeneratorResult?.(fixtures[1], {
              finalText: JSON.stringify({
                files: [{ path: 'proposal.md', content: '# Recorded proposal' }],
                openQuestions: [],
                assumptions: ['Existing metrics remain valid.'],
                risks: [],
              }),
              usage: { input_tokens: 40, cached_input_tokens: 5, output_tokens: 7 },
              costMicroUsd: 321,
            });
            return {
              schemaId: 'specify-response-v1',
              results: [
                {
                  id: 'parse-error',
                  status: 'parse_error',
                  openQuestionsCount: 0,
                  assumptionsCount: 0,
                  risksCount: 0,
                  filesCount: 0,
                  costMicroUsd: 20,
                  totalTokens: 5,
                  errorMessage: 'Response was not valid JSON: Unexpected token i',
                },
                {
                  id: 'record-me',
                  status: 'refined',
                  openQuestionsCount: 0,
                  assumptionsCount: 1,
                  risksCount: 0,
                  filesCount: 1,
                  costMicroUsd: 321,
                  totalTokens: 47,
                },
              ],
              summary: {
                total: 2,
                byStatus: { refined: 1, needs_input: 0, parse_error: 1, schema_error: 0 },
                totalCostMicroUsd: 341,
                totalTokens: 52,
                avgCostMicroUsd: 170.5,
                expectationMismatches: 0,
              },
            } as any;
          },
          stdout: { write: () => true },
          stderr: { write: () => true },
        },
      );

      assert.strictEqual(exitCode, 0);

      const recordedFixture = JSON.parse(await readFile(successPath, 'utf8')) as any;
      assert.strictEqual(recordedFixture.expected.status, 'refined');
      assert.strictEqual(recordedFixture.fixturePath, undefined);
      assert.strictEqual(recordedFixture.recordedCostMicroUsd, 321);
      assert.deepStrictEqual(recordedFixture.recordedUsage, {
        input_tokens: 40,
        cached_input_tokens: 5,
        output_tokens: 7,
      });
      assert.strictEqual(JSON.parse(recordedFixture.recordedFinalText).assumptions[0], 'Existing metrics remain valid.');

      const parseErrorFixture = JSON.parse(await readFile(parseErrorPath, 'utf8')) as any;
      assert.strictEqual(parseErrorFixture.recordedFinalText, undefined);
      assert.strictEqual(parseErrorFixture.recordedUsage, undefined);
      assert.strictEqual(parseErrorFixture.recordedCostMicroUsd, undefined);

      const untouchedFixture = JSON.parse(await readFile(untouchedPath, 'utf8')) as any;
      assert.strictEqual(untouchedFixture.recordedFinalText, undefined);
      assert.strictEqual(untouchedFixture.recordedUsage, undefined);
      assert.strictEqual(untouchedFixture.recordedCostMicroUsd, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('includes judge telemetry in live-mode JSON output and treats revise verdicts as failures', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--judge', '--json'],
      {
        loadFixtures: async () => [{ id: 'live-specify' } as any],
        runReplaySuite: () => {
          throw new Error('replay suite should not run in live mode');
        },
        runLiveSuite: async (_fixtures, options) => {
          assert.deepStrictEqual((options as any).judge, { maxRevisions: 0 });
          return {
            schemaId: 'specify-response-v1',
            results: [{
              id: 'live-specify',
              status: 'refined',
              openQuestionsCount: 0,
              assumptionsCount: 0,
              risksCount: 0,
              filesCount: 2,
              costMicroUsd: 0,
              totalTokens: 42,
              judge: {
                maxRevisions: 0,
                revisionCount: 0,
                finalVerdict: 'revise',
                attempts: [{
                  attempt: 1,
                  verdict: 'revise',
                  summary: 'The proposal should tighten the acceptance criteria.',
                  issues: [{ code: 'definition-of-done', message: 'Add a checkable acceptance criterion.' }],
                  costMicroUsd: 10,
                  totalTokens: 4,
                }],
              },
            }],
            summary: {
              total: 1,
              byStatus: { refined: 1, needs_input: 0, parse_error: 0, schema_error: 0 },
              totalCostMicroUsd: 0,
              totalTokens: 42,
              avgCostMicroUsd: 0,
              expectationMismatches: 0,
            },
            judgeSummary: {
              totalFixtures: 1,
              byVerdict: { pass: 0, revise: 1, error: 0 },
              totalJudgeCostMicroUsd: 10,
              totalJudgeTokens: 4,
              totalRevisions: 0,
            },
          } as any;
        },
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: () => true },
      },
    );

    assert.strictEqual(exitCode, 1);
    const parsed = JSON.parse(stdout) as any;
    assert.strictEqual(parsed.mode, 'live');
    assert.strictEqual(parsed.results[0]?.judge?.finalVerdict, 'revise');
    assert.strictEqual(parsed.judgeSummary?.byVerdict?.revise, 1);
  });

  it('prints replay parse/schema error details in text mode', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir],
      {
        loadFixtures: async () => [{ id: 'parse-error' } as any],
        runReplaySuite: () => ({
          schemaId: 'specify-response-v1',
          results: [{
            id: 'parse-error',
            status: 'parse_error',
            openQuestionsCount: 0,
            assumptionsCount: 0,
            risksCount: 0,
            filesCount: 0,
            costMicroUsd: 0,
            totalTokens: 0,
            errorMessage: 'Response was not valid JSON: Unexpected token x',
          }],
          summary: {
            total: 1,
            byStatus: { refined: 0, needs_input: 0, parse_error: 1, schema_error: 0 },
            totalCostMicroUsd: 0,
            totalTokens: 0,
            avgCostMicroUsd: 0,
            expectationMismatches: 0,
          },
        }) as any,
        runLiveSuite: async () => { throw new Error('live suite should not run in replay mode'); },
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: () => true },
      },
    );

    assert.strictEqual(exitCode, 1);
    assert.match(stdout, /Response was not valid JSON: Unexpected token x/);
  });

  it('documents judge revise/error failures in the help text', async () => {
    let stdout = '';
    const exitCode = await main(['--help'], {
      loadFixtures: async () => [],
      runReplaySuite: () => { throw new Error('should not run'); },
      runLiveSuite: async () => { throw new Error('should not run'); },
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: () => true },
    });

    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /judge revise\/error/i);
  });
});

async function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register', cliPath, ...args], {
      cwd: orchestratorRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}