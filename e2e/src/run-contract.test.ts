import assert from 'assert';
import { describe, it } from 'mocha';
import {
  REQUIRED_STATUS_SEQUENCE,
  assertObservedStatusSequence,
  buildSeedIssueBody,
  buildSeedIssueTitle,
} from './run-contract';

describe('run contract helpers', () => {
  it('builds seed issue content with an embedded run marker', () => {
    assert.strictEqual(buildSeedIssueTitle('run-123'), '[e2e] orchestrator live test run-123');
    const body = buildSeedIssueBody('run-123');

    assert.match(body, /E2E_RUN_MARKER: run-123/);
    assert.match(body, /easy to verify/i);
    assert.match(body, /include the run marker `run-123` somewhere in the metadata/i);
  });

  it('accepts an observed status sequence that includes the required progression', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Ready', 'In progress', 'In review']);
    });
    assert.deepStrictEqual(REQUIRED_STATUS_SEQUENCE, ['Ready', 'In progress', 'In review']);
  });

  it('accepts richer donor-compatible board lifecycles around the current ready flow', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Backlog', 'Refinement', 'Refined', 'Ready', 'In progress', 'In review', 'Ready to merge']);
    });
  });

  it('rejects a status sequence that skips In progress', () => {
    assert.throws(
      () => assertObservedStatusSequence(['Ready', 'In review']),
      /observed statuses did not include the required sequence/i,
    );
  });

  it('rejects non-canonical board status names', () => {
    assert.throws(
      () => assertObservedStatusSequence(['Ready', 'In Progress', 'In review']),
      /non-canonical board statuses/i,
    );
  });
});