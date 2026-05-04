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

  it('rejects a global phase provider that conflicts with an inherited global default model', () => {
    assert.throws(
      () => shared.resolveEffectivePhaseAgentProviderSelection('implement', {
        default: { config: { model: 'gpt-5.4' } },
        implement: { provider: 'anthropic' },
      }, undefined),
      /does not match provider/i,
    );
  });

  it('rejects a project default provider that conflicts with an inherited global phase model', () => {
    assert.throws(
      () => shared.resolveEffectivePhaseAgentProviderSelection('review', {
        review: { config: { model: 'gpt-5.4' } },
      }, {
        agentDefaults: { provider: 'anthropic' },
        agents: {},
      }),
      /does not match provider/i,
    );
  });

  it('rejects a project phase provider that conflicts with an inherited project default model', () => {
    assert.throws(
      () => shared.resolveEffectivePhaseAgentProviderSelection('specify', undefined, {
        agentDefaults: { config: { model: 'gpt-5.4' } },
        agents: { specify: { provider: 'anthropic' } },
      }),
      /does not match provider/i,
    );
  });
});