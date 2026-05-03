import assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import {
  SPECIFY_REPLAY_SCHEMA_ID,
  loadSpecifyReplayFixtures,
  runSpecifyReplayFixture,
  runSpecifyReplaySuite,
} from '../eval/specify-replay';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'specify');

describe('specify replay eval harness', () => {
  it('loads replay fixtures from disk and aggregates replay statuses', async () => {
    const fixtures = await loadSpecifyReplayFixtures(FIXTURES_DIR);
    const suite = runSpecifyReplaySuite(fixtures) as any;

    assert.strictEqual(fixtures.length, 13);
    assert.deepStrictEqual(suite.summary.byStatus, {
      refined: 5,
      needs_input: 3,
      parse_error: 2,
      schema_error: 3,
    });
    assert.strictEqual(suite.schemaId, SPECIFY_REPLAY_SCHEMA_ID);
    assert.strictEqual(suite.summary.total, 13);
    assert.strictEqual(suite.summary.expectationMismatches, 0);
    assert.ok(suite.summary.totalTokens > 0);
    assert.ok(suite.summary.totalCostMicroUsd > 0);

    const observedStatuses = Object.fromEntries(suite.results.map((result: any) => [result.id, result.status]));
    assert.deepStrictEqual(observedStatuses, {
      'cli-flag-addition': 'refined',
      'duplicate-files': 'schema_error',
      'malformed-json': 'parse_error',
      'multi-capability-recurrence': 'refined',
      'needs-input-follow-up-question': 'needs_input',
      'needs-input-vague': 'needs_input',
      'out-of-scope-feature': 'needs_input',
      'parse-error-non-json-response': 'parse_error',
      'path-policy-violation': 'schema_error',
      'prior-draft-iteration': 'refined',
      'refined-bug-fix': 'refined',
      'refined-minimal-spec-bundle': 'refined',
      'schema-error-missing-required-file': 'schema_error',
    });
  });

  it('includes the fixture path when malformed fixture JSON fails to load', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'specify-replay-fixtures-'));
    const fixturePath = path.join(tempDir, 'broken.json');
    try {
      await writeFile(fixturePath, '{not valid json', 'utf8');
      await assert.rejects(
        () => loadSpecifyReplayFixtures(tempDir),
        (error: unknown) => {
          assert.match(String(error), /broken\.json/);
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports expectation mismatches with expected and observed statuses', () => {
    const suite = runSpecifyReplaySuite([
      {
        id: 'mismatch-needs-input',
        ticket: { title: 'Mismatch fixture', description: 'Need one open question.', labels: [] },
        priorDraft: [],
        operatorComments: [],
        recordedFinalText: JSON.stringify({
          files: [
            { path: 'proposal.md', content: '# Proposal' },
            { path: 'tasks.md', content: '- [ ] Follow up' },
          ],
          openQuestions: ['Need a product decision'],
          assumptions: [],
          risks: [],
        }),
        expected: { status: 'refined' },
      },
    ]) as any;

    assert.strictEqual(suite.summary.expectationMismatches, 1);
    assert.match(suite.results[0]?.expectationMismatch ?? '', /expected status/i);
  });

  it('classifies fixtures without expectations without counting them as matched or mismatched', () => {
    const suite = runSpecifyReplaySuite([
      {
        id: 'no-expected-status',
        ticket: { title: 'No expectation', description: 'Still valid replay fixture.', labels: [] },
        priorDraft: [],
        operatorComments: [],
        recordedFinalText: JSON.stringify({
          files: [
            { path: 'proposal.md', content: '# Proposal' },
            { path: 'tasks.md', content: '- [ ] Build replay suite' },
          ],
          openQuestions: [],
          assumptions: [],
          risks: [],
        }),
      },
    ]) as any;

    assert.strictEqual(suite.results[0]?.status, 'refined');
    assert.strictEqual(suite.results[0]?.expectationMismatch, undefined);
    assert.strictEqual(suite.summary.expectationMismatches, 0);
  });

  it('distinguishes JSON parse failures from specify schema failures', () => {
    const parseError = runSpecifyReplayFixture({
      id: 'bad-json',
      ticket: { title: 'Bad JSON', description: 'Broken response.', labels: [] },
      priorDraft: [],
      operatorComments: [],
      recordedFinalText: '{not valid json',
      recordedUsage: { input_tokens: 11, cached_input_tokens: 5, output_tokens: 3 },
      recordedCostMicroUsd: 99,
    }) as any;
    assert.strictEqual(parseError.status, 'parse_error');
    assert.match(parseError.errorMessage ?? '', /valid JSON/i);
    assert.strictEqual(parseError.totalTokens, 14);
    assert.strictEqual(parseError.costMicroUsd, 99);

    const schemaError = runSpecifyReplayFixture({
      id: 'missing-required-file',
      ticket: { title: 'Schema error', description: 'Missing required tasks.md.', labels: [] },
      priorDraft: [],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        files: [{ path: 'proposal.md', content: '# Proposal' }],
        openQuestions: [],
        assumptions: [],
        risks: [],
      }),
      recordedUsage: { input_tokens: 8, cached_input_tokens: 1, output_tokens: 2 },
      recordedCostMicroUsd: 55,
    }) as any;
    assert.strictEqual(schemaError.status, 'schema_error');
    assert.match(schemaError.errorMessage ?? '', /tasks\.md/i);
    assert.strictEqual(schemaError.totalTokens, 10);
    assert.strictEqual(schemaError.costMicroUsd, 55);
  });

  it('uses donor-style recorded usage and expectation ranges when evaluating fixtures', async () => {
    const rawFixture = JSON.parse(await readFile(path.join(FIXTURES_DIR, 'out-of-scope-feature.json'), 'utf8'));
    const result = runSpecifyReplayFixture(rawFixture) as any;

    assert.strictEqual(result.id, 'out-of-scope-feature');
    assert.strictEqual(result.status, 'needs_input');
    assert.strictEqual(result.openQuestionsCount, 3);
    assert.strictEqual(result.assumptionsCount, 0);
    assert.strictEqual(result.risksCount, 0);
    assert.strictEqual(result.filesCount, 2);
    assert.strictEqual(result.totalTokens, 930);
    assert.strictEqual(result.costMicroUsd, 2400);
    assert.strictEqual(result.expectationMismatch, undefined);
  });

  it('reports donor-style min/max open question expectation mismatches', () => {
    const tooFew = runSpecifyReplayFixture({
      id: 'min-open-questions-mismatch',
      ticket: { title: 'Need more questions', description: 'Synthetic replay fixture.', labels: [] },
      priorDraft: [],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        files: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Ask more questions' },
        ],
        openQuestions: ['Need one answer'],
        assumptions: [],
        risks: [],
      }),
      expected: { status: 'needs_input', minOpenQuestions: 2 },
    }) as any;
    assert.match(tooFew.expectationMismatch ?? '', /openQuestions 1 < min 2/i);

    const tooMany = runSpecifyReplayFixture({
      id: 'max-open-questions-mismatch',
      ticket: { title: 'Should be refined', description: 'Synthetic replay fixture.', labels: [] },
      priorDraft: [],
      operatorComments: [],
      recordedFinalText: JSON.stringify({
        files: [
          { path: 'proposal.md', content: '# Proposal' },
          { path: 'tasks.md', content: '- [ ] Finish scope' },
        ],
        openQuestions: ['Unexpected follow-up'],
        assumptions: [],
        risks: [],
      }),
      expected: { status: 'needs_input', maxOpenQuestions: 0 },
    }) as any;
    assert.match(tooMany.expectationMismatch ?? '', /openQuestions 1 > max 0/i);
  });
});