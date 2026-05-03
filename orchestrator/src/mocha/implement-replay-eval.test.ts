import assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import {
  IMPLEMENT_REPLAY_SCHEMA_ID,
  loadImplementReplayFixtures,
  runImplementReplayFixture,
  runImplementReplaySuite,
} from '../eval/implement-replay';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'implement');

describe('implement replay eval harness', () => {
  it('loads replay fixtures from disk and aggregates replay statuses', async () => {
    const fixtures = await loadImplementReplayFixtures(FIXTURES_DIR);
    const suite = runImplementReplaySuite(fixtures) as any;

    assert.strictEqual(fixtures.length, 7);
    assert.deepStrictEqual(suite.summary.byStatus, {
      produced: 4,
      empty: 1,
      parse_error: 1,
      schema_error: 1,
    });
    assert.strictEqual(suite.schemaId, IMPLEMENT_REPLAY_SCHEMA_ID);
    assert.strictEqual(suite.summary.total, 7);
    assert.strictEqual(suite.summary.expectationMismatches, 0);
    assert.ok(suite.summary.totalTokens > 0);
    assert.ok(suite.summary.totalCostMicroUsd > 0);

    const observedStatuses = Object.fromEntries(suite.results.map((result: any) => [result.id, result.status]));
    assert.deepStrictEqual(observedStatuses, {
      'cli-flag-strict': 'produced',
      'empty-no-changes': 'empty',
      'parse-error-prose': 'parse_error',
      'refined-bug-fix': 'produced',
      'retry-jitter': 'produced',
      'schema-error-absolute-path': 'schema_error',
      'vague-scope-creep': 'produced',
    });
  });

  it('includes the fixture path when schema-invalid fixtures fail to load', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'implement-replay-fixtures-'));
    const fixturePath = path.join(tempDir, 'invalid.json');
    try {
      await writeFile(fixturePath, JSON.stringify({
        id: 'missing-spec-bundle',
        ticket: { title: 'Invalid fixture', description: 'Missing the required spec bundle.', labels: [] },
        operatorComments: [],
        recordedFinalText: JSON.stringify({ filesWritten: [], commitMessage: 'x', summary: 'x', followUps: [] }),
      }, null, 2), 'utf8');
      await assert.rejects(
        () => loadImplementReplayFixtures(tempDir),
        (error: unknown) => {
          assert.match(String(error), /invalid\.json/);
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports expectation mismatches with expected and observed statuses', () => {
    const suite = runImplementReplaySuite([
      {
        id: 'mismatch-empty',
        ticket: { title: 'Mismatch fixture', description: 'Expected a code change.', labels: [] },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Verify no code changes are needed' },
        ],
        operatorComments: [],
        recordedFinalText: JSON.stringify({
          filesWritten: [],
          commitMessage: 'chore: confirm no changes required',
          summary: 'Verified the branch already contains the requested update.',
          followUps: [],
        }),
        expected: { status: 'produced' },
      },
    ]) as any;

    assert.strictEqual(suite.summary.expectationMismatches, 1);
    assert.match(suite.results[0]?.expectationMismatch ?? '', /expected status/i);
  });

  it('classifies fixtures without expectations without counting them as matched or mismatched', () => {
    const suite = runImplementReplaySuite([
      {
        id: 'no-expected-status',
        ticket: { title: 'No expectation', description: 'Still valid replay fixture.', labels: [] },
        specBundle: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Add a small implementation change' },
        ],
        operatorComments: [],
        recordedFinalText: JSON.stringify({
          filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }],
          commitMessage: 'feat: add ok export',
          summary: 'Adds the requested export.',
          followUps: [],
        }),
      },
    ]) as any;

    assert.strictEqual(suite.results[0]?.status, 'produced');
    assert.strictEqual(suite.results[0]?.expectationMismatch, undefined);
    assert.strictEqual(suite.summary.expectationMismatches, 0);
  });

  it('distinguishes JSON parse failures from implement schema failures', () => {
    const parseError = runImplementReplayFixture({
      id: 'bad-json',
      ticket: { title: 'Bad JSON', description: 'Broken response.', labels: [] },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Parse the response' },
      ],
      operatorComments: [],
      recordedFinalText: '{not valid json',
      recordedUsage: { input_tokens: 11, cached_input_tokens: 5, output_tokens: 3 },
      recordedCostMicroUsd: 99,
    }) as any;
    assert.strictEqual(parseError.status, 'parse_error');
    assert.match(parseError.errorMessage ?? '', /valid JSON/i);
    assert.strictEqual(parseError.totalTokens, 14);
    assert.strictEqual(parseError.costMicroUsd, 99);

    const schemaError = runImplementReplayFixture({
      id: 'absolute-path',
      ticket: { title: 'Schema error', description: 'Absolute path should fail.', labels: [] },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Keep writes repo-relative' },
      ],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        filesWritten: [{ path: '/tmp/bad.ts', content: 'export const bad = true;\n' }],
        commitMessage: 'feat: bad path',
        summary: 'Should fail schema validation.',
        followUps: [],
      }),
      recordedUsage: { input_tokens: 8, cached_input_tokens: 1, output_tokens: 2 },
      recordedCostMicroUsd: 55,
    }) as any;
    assert.strictEqual(schemaError.status, 'schema_error');
    assert.match(schemaError.errorMessage ?? '', /repo-relative POSIX path|absolute/i);
    assert.strictEqual(schemaError.totalTokens, 10);
    assert.strictEqual(schemaError.costMicroUsd, 55);
  });

  it('uses donor-style recorded usage and expectation ranges when evaluating fixtures', async () => {
    const rawFixture = JSON.parse(await readFile(path.join(FIXTURES_DIR, 'empty-no-changes.json'), 'utf8'));
    const result = runImplementReplayFixture(rawFixture) as any;

    assert.strictEqual(result.id, 'empty-no-changes');
    assert.strictEqual(result.status, 'empty');
    assert.strictEqual(result.filesWrittenCount, 0);
    assert.strictEqual(result.followUpsCount, 1);
    assert.strictEqual(result.totalTokens, 890);
    assert.strictEqual(result.costMicroUsd, 1100);
    assert.strictEqual(result.expectationMismatch, undefined);
  });

  it('reports donor-style min/max filesWritten expectation mismatches', () => {
    const tooFew = runImplementReplayFixture({
      id: 'min-files-mismatch',
      ticket: { title: 'Need more files', description: 'Synthetic replay fixture.', labels: [] },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Write two files' },
      ],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        filesWritten: [{ path: 'src/index.ts', content: 'export const onlyOne = true;\n' }],
        commitMessage: 'feat: add one file',
        summary: 'Adds one file.',
        followUps: [],
      }),
      expected: { status: 'produced', minFilesWritten: 2 },
    }) as any;
    assert.match(tooFew.expectationMismatch ?? '', /filesWritten 1 < min 2/i);

    const tooMany = runImplementReplayFixture({
      id: 'max-files-mismatch',
      ticket: { title: 'Should be empty', description: 'Synthetic replay fixture.', labels: [] },
      specBundle: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '- [ ] Confirm there are no required edits' },
      ],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        filesWritten: [{ path: 'src/index.ts', content: 'export const unexpected = true;\n' }],
        commitMessage: 'feat: unexpected change',
        summary: 'Unexpectedly writes a file.',
        followUps: [],
      }),
      expected: { status: 'produced', maxFilesWritten: 0 },
    }) as any;
    assert.match(tooMany.expectationMismatch ?? '', /filesWritten 1 > max 0/i);
  });
});