import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'mocha';
import { main, parseEvalSpecifyCliArgs } from '../cli/eval-specify';

const orchestratorRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(orchestratorRoot, 'src', 'cli', 'eval-specify.ts');
const fixturesDir = path.join(orchestratorRoot, 'eval', 'fixtures', 'specify');

describe('specify eval cli', () => {
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
    });
  });

  it('dispatches live mode through the live suite and preserves the CLI JSON shape', async () => {
    let stdout = '';
    const exitCode = await main(
      ['--fixtures', fixturesDir, '--mode', 'live', '--worktree', '/tmp/live-repo', '--json'],
      {
        loadFixtures: async () => [{ id: 'live-specify' } as any],
        runReplaySuite: () => {
          throw new Error('replay suite should not run in live mode');
        },
        runLiveSuite: async (_fixtures, options) => {
          assert.strictEqual(options.worktreePath, path.resolve('/tmp/live-repo'));
          assert.strictEqual(options.timeoutMs, 300000);
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