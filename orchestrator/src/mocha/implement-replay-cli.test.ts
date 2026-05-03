import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'mocha';
import { main, parseEvalImplementCliArgs } from '../cli/eval-implement';

const orchestratorRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(orchestratorRoot, 'src', 'cli', 'eval-implement.ts');
const fixturesDir = path.join(orchestratorRoot, 'eval', 'fixtures', 'implement');

describe('implement eval cli', () => {
  it('emits donor-like JSON output and supports fixture filtering in replay mode', async () => {
    const result = await runCli(['--fixtures', fixturesDir, '--fixture', 'empty-no-changes', '--json']);

    assert.strictEqual(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as any;
    assert.strictEqual(parsed.mode, 'replay');
    assert.strictEqual(parsed.results.length, 1);
    assert.strictEqual(parsed.results[0]?.id, 'empty-no-changes');
    assert.strictEqual(parsed.results[0]?.status, 'empty');
    assert.strictEqual(parsed.summary.total, 1);
    assert.deepStrictEqual(parsed.summary.byStatus, {
      produced: 0,
      empty: 1,
      parse_error: 0,
      schema_error: 0,
    });
  });

  it('returns exit code 1 when replay expectations mismatch', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'implement-replay-cli-'));
    try {
      await writeFile(path.join(tempDir, 'mismatch.json'), JSON.stringify({
        id: 'cli-mismatch',
        ticket: { title: 'Mismatch', description: 'Synthetic fixture for CLI exit-code coverage.' },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Confirm there are no edits' },
        ],
        recordedFinalText: JSON.stringify({
          filesWritten: [],
          commitMessage: 'chore: confirm no edits',
          summary: 'Verified that the requested change is already present.',
          followUps: [],
        }),
        expected: { status: 'produced' },
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
    const parsed = parseEvalImplementCliArgs(['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--fixture', 'empty-no-changes']);

    assert.deepStrictEqual(parsed, {
      fixturesDir: path.resolve(fixturesDir),
      fixtureIds: ['empty-no-changes'],
      json: false,
      mode: 'live',
      worktreePath: path.resolve('/tmp/live-repo'),
      timeoutMs: 300000,
    });
  });

  it('parses optional judge flags for live mode and rejects them in replay mode', () => {
    const parsed = parseEvalImplementCliArgs([
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
      judge: { maxRevisions: 1 },
    });

    assert.throws(
      () => parseEvalImplementCliArgs(['--fixtures', fixturesDir, '--judge']),
      /live mode/i,
    );
  });

  it('dispatches live mode through the live suite and preserves the CLI JSON shape', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--json'],
      {
        loadFixtures: async () => [{ id: 'live-implement' } as any],
        runReplaySuite: () => {
          throw new Error('replay suite should not run in live mode');
        },
        runLiveSuite: async (_fixtures, options) => {
          assert.strictEqual(options.worktreePath, path.resolve('/tmp/live-repo'));
          assert.strictEqual(options.timeoutMs, 300000);
          return {
            schemaId: 'implement-response-v1',
            results: [{
              id: 'live-implement',
              status: 'produced',
              filesWrittenCount: 1,
              totalContentChars: 12,
              commitMessageLength: 20,
              summaryLength: 24,
              followUpsCount: 0,
              costMicroUsd: 0,
              totalTokens: 84,
            }],
            summary: {
              total: 1,
              byStatus: { produced: 1, empty: 0, parse_error: 0, schema_error: 0 },
              totalCostMicroUsd: 0,
              totalTokens: 84,
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
    assert.strictEqual(parsed.results[0]?.id, 'live-implement');
    assert.strictEqual(parsed.summary.total, 1);
  });

  it('includes judge telemetry in live-mode JSON output and treats judge errors as failures', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--judge', '--json'],
      {
        loadFixtures: async () => [{ id: 'live-implement' } as any],
        runReplaySuite: () => {
          throw new Error('replay suite should not run in live mode');
        },
        runLiveSuite: async (_fixtures, options) => {
          assert.deepStrictEqual((options as any).judge, { maxRevisions: 0 });
          return {
            schemaId: 'implement-response-v1',
            results: [{
              id: 'live-implement',
              status: 'produced',
              filesWrittenCount: 1,
              totalContentChars: 12,
              commitMessageLength: 20,
              summaryLength: 24,
              followUpsCount: 0,
              costMicroUsd: 0,
              totalTokens: 84,
              judge: {
                maxRevisions: 0,
                revisionCount: 0,
                finalVerdict: 'error',
                attempts: [{
                  attempt: 1,
                  verdict: 'error',
                  issues: [],
                  errorMessage: 'Judge runner failed: transport dropped',
                  costMicroUsd: 0,
                  totalTokens: 0,
                }],
              },
            }],
            summary: {
              total: 1,
              byStatus: { produced: 1, empty: 0, parse_error: 0, schema_error: 0 },
              totalCostMicroUsd: 0,
              totalTokens: 84,
              avgCostMicroUsd: 0,
              expectationMismatches: 0,
            },
            judgeSummary: {
              totalFixtures: 1,
              byVerdict: { pass: 0, revise: 0, error: 1 },
              totalJudgeCostMicroUsd: 0,
              totalJudgeTokens: 0,
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
    assert.strictEqual(parsed.results[0]?.judge?.finalVerdict, 'error');
    assert.strictEqual(parsed.judgeSummary?.byVerdict?.error, 1);
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