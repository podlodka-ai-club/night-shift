import assert from 'assert';
import { describe, it } from 'mocha';
import {
  REQUIRED_ESCALATION_HUMAN_FALLBACK_SEQUENCE,
  REQUIRED_IMPLEMENT_ESCALATION_RECOVERY_SEQUENCE,
  REQUIRED_REVIEW_ONLY_ESCALATION_RECOVERY_SEQUENCE,
  REQUIRED_SPECIFY_ESCALATION_RECOVERY_SEQUENCE,
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
      assertObservedStatusSequence(['Ready', 'In progress', 'In review', 'Ready to merge']);
    });
    assert.deepStrictEqual(REQUIRED_STATUS_SEQUENCE, ['Ready', 'In progress', 'In review', 'Ready to merge']);
  });

  it('accepts a fake-agent review rerun sequence before Ready to merge', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Ready to merge']);
    });
  });

  it('accepts richer donor-compatible board lifecycles around the current ready flow', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Backlog', 'Refinement', 'Refined', 'Ready', 'In progress', 'In review', 'Ready to merge']);
    });
  });

  it('accepts implement escalation recovery back through Ready', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Ready', 'In progress', 'Escalated', 'Ready', 'In progress', 'In review', 'Ready to merge']);
    });
    assert.deepStrictEqual(REQUIRED_IMPLEMENT_ESCALATION_RECOVERY_SEQUENCE, ['Ready', 'In progress', 'Escalated', 'Ready', 'In progress', 'In review', 'Ready to merge']);
  });

  it('accepts specify escalation recovery back through Backlog', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Backlog', 'Refinement', 'Escalated', 'Backlog', 'Refinement', 'Refined', 'Ready', 'In progress', 'In review', 'Ready to merge']);
    });
    assert.deepStrictEqual(REQUIRED_SPECIFY_ESCALATION_RECOVERY_SEQUENCE, ['Backlog', 'Refinement', 'Escalated', 'Backlog', 'Refinement', 'Refined', 'Ready', 'In progress', 'In review', 'Ready to merge']);
  });

  it('accepts review-only escalation recovery back through In review', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Escalated', 'In review', 'Ready to merge']);
    });
    assert.deepStrictEqual(REQUIRED_REVIEW_ONLY_ESCALATION_RECOVERY_SEQUENCE, ['Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Escalated', 'In review', 'Ready to merge']);
  });

  it('accepts escalation handoff to Blocked for human fallback', () => {
    assert.doesNotThrow(() => {
      assertObservedStatusSequence(['Ready', 'In progress', 'Escalated', 'Blocked']);
    });
    assert.deepStrictEqual(REQUIRED_ESCALATION_HUMAN_FALLBACK_SEQUENCE, ['Ready', 'In progress', 'Escalated', 'Blocked']);
  });

  it('rejects a status sequence that skips In progress', () => {
    assert.throws(
      () => assertObservedStatusSequence(['Ready', 'In review']),
      /observed statuses did not include an allowed sequence/i,
    );
  });

  it('rejects non-canonical board status names', () => {
    assert.throws(
      () => assertObservedStatusSequence(['Ready', 'In Progress', 'In review']),
      /non-canonical board statuses/i,
    );
  });

  it('rejects invalid transitions out of Escalated', () => {
    assert.throws(
      () => assertObservedStatusSequence(['Ready', 'In progress', 'Escalated', 'In progress']),
      /invalid Escalated transition/i,
    );
  });
});