import assert from 'assert';
import { describe, it } from 'mocha';
import * as shared from '../shared';

describe('shared deterministic-phase contracts', () => {
  it('exposes the donor-compatible canonical project statuses and current ready flow', () => {
    assert.deepStrictEqual((shared as Record<string, unknown>).CANONICAL_PROJECT_STATUS_NAMES, [
      'Backlog',
      'Refinement',
      'Refined',
      'Ready',
      'In progress',
      'In review',
      'Ready to merge',
      'Escalated',
      'Blocked',
    ]);
    assert.deepStrictEqual((shared as Record<string, unknown>).READY_ISSUE_STATUS_SEQUENCE, [
      'Ready',
      'In progress',
      'In review',
      'Ready to merge',
    ]);
  });

  it('freezes the copied blocked-reason and board-signal contract for later workflow tests', () => {
    assert.deepStrictEqual((shared as Record<string, unknown>).BLOCKED_REASON_BOARD_SIGNAL_RULES, [
      { blockedReason: 'specify_needs_input', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
      { blockedReason: 'awaiting_spec_review', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
      { blockedReason: 'awaiting_spec_review', boardStatusName: 'Ready', signalName: 'specReviewed' },
      { blockedReason: 'implement_needs_input', boardStatusName: 'Backlog', signalName: 'specifyRetry' },
      { blockedReason: 'implement_needs_input', boardStatusName: 'Ready', signalName: 'implementRetry' },
      { blockedReason: 'review_escalation', boardStatusName: 'Ready', signalName: 'resume' },
      { blockedReason: 'review_escalation', boardStatusName: 'In review', signalName: 'resumeReviewOnly' },
    ]);
  });
});