import assert from 'assert';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/common';
import { describe, it } from 'mocha';
import type { AutomateReadyIssueInput, SelectedProjectIssue } from '../shared';
import {
  buildManualCandidate,
  buildIssueWorkflowId,
  buildPickupCandidates,
  handleWorkflowTrigger,
  runPickupIntake,
  resolveWorkflowTriggerAction,
  type IntakeCandidate,
} from '../intake';
import { buildSelectedIssue } from './activity-test-helpers';

describe('intake trigger handling', () => {
  it('resolves donor-compatible start, signal, and noop decisions', () => {
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Backlog', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'missing' } }),
      { type: 'start', workflowId: 'ticket-7', startPhase: 'specify' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Backlog', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'closed' } }),
      { type: 'start', workflowId: 'ticket-7', startPhase: 'specify' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'missing' } }),
      { type: 'start', workflowId: 'ticket-7', startPhase: 'implement' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'closed' } }),
      { type: 'start', workflowId: 'ticket-7', startPhase: 'implement' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Backlog', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'specify_needs_input' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'specifyRetry' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Backlog', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'awaiting_spec_review' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'specifyRetry' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'awaiting_spec_review' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'specReviewed' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Backlog', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'implement_needs_input' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'specifyRetry' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'implement_needs_input' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'implementRetry' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'review_escalation' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'resume' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'In review', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'review_escalation' } }),
      { type: 'signal', workflowId: 'ticket-7', signalName: 'resumeReviewOnly' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: 'specify_needs_input' } }),
      { type: 'noop', workflowId: 'ticket-7', reason: 'blocked_reason_mismatch' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Ready', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'open', blockedReason: null } }),
      { type: 'noop', workflowId: 'ticket-7', reason: 'already_running' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'In review', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'missing' } }),
      { type: 'noop', workflowId: 'ticket-7', reason: 'unsupported_start_status' },
    );
    assert.deepStrictEqual(
      resolveWorkflowTriggerAction({ boardStatusName: 'Escalated', workflowId: buildIssueWorkflowId(7), workflowState: { kind: 'missing' } }),
      { type: 'noop', workflowId: 'ticket-7', reason: 'unsupported_start_status' },
    );
  });

  it('merges pickup backlog and ready items by createdAt and tags the correct start phases', () => {
    const backlogIssue = buildListedIssue({ issueNumber: 5, statusName: 'Backlog', createdAt: '2026-04-28T10:00:00.000Z' });
    const readyIssue = buildListedIssue({ issueNumber: 7, statusName: 'Ready', createdAt: '2026-04-28T09:00:00.000Z' });
    const newerBacklog = buildListedIssue({ issueNumber: 9, statusName: 'Backlog', createdAt: '2026-04-28T11:00:00.000Z' });

    assert.deepStrictEqual(buildPickupCandidates([backlogIssue, newerBacklog], [readyIssue]), [
      { issue: readyIssue, boardStatusName: 'Ready', createdAt: readyIssue.createdAt, startPhase: 'implement' },
      { issue: backlogIssue, boardStatusName: 'Backlog', createdAt: backlogIssue.createdAt, startPhase: 'specify' },
      { issue: newerBacklog, boardStatusName: 'Backlog', createdAt: newerBacklog.createdAt, startPhase: 'specify' },
    ]);
  });

  it('maps manual intake statuses to start phases explicitly', () => {
    assert.deepStrictEqual(
      buildManualCandidate(buildListedIssue({ issueNumber: 5, statusName: 'Backlog', createdAt: '2026-04-28T10:00:00.000Z' })),
      {
        issue: buildListedIssue({ issueNumber: 5, statusName: 'Backlog', createdAt: '2026-04-28T10:00:00.000Z' }),
        boardStatusName: 'Backlog',
        createdAt: '2026-04-28T10:00:00.000Z',
        startPhase: 'specify',
      },
    );
    assert.deepStrictEqual(
      buildManualCandidate(buildListedIssue({ issueNumber: 6, statusName: 'Ready', createdAt: '2026-04-28T11:00:00.000Z' })),
      {
        issue: buildListedIssue({ issueNumber: 6, statusName: 'Ready', createdAt: '2026-04-28T11:00:00.000Z' }),
        boardStatusName: 'Ready',
        createdAt: '2026-04-28T11:00:00.000Z',
        startPhase: 'implement',
      },
    );
    assert.deepStrictEqual(
      buildManualCandidate({ ...buildListedIssue({ issueNumber: 7, statusName: 'Ready', createdAt: '2026-04-28T12:00:00.000Z' }), currentStatusName: 'In review' }),
      {
        issue: { ...buildListedIssue({ issueNumber: 7, statusName: 'Ready', createdAt: '2026-04-28T12:00:00.000Z' }), currentStatusName: 'In review' },
        boardStatusName: 'In review',
        createdAt: '2026-04-28T12:00:00.000Z',
        startPhase: undefined,
      },
    );
    assert.deepStrictEqual(
      buildManualCandidate({ ...buildListedIssue({ issueNumber: 8, statusName: 'Ready', createdAt: '2026-04-28T13:00:00.000Z' }), currentStatusName: 'Escalated' }),
      {
        issue: { ...buildListedIssue({ issueNumber: 8, statusName: 'Ready', createdAt: '2026-04-28T13:00:00.000Z' }), currentStatusName: 'Escalated' },
        boardStatusName: 'Escalated',
        createdAt: '2026-04-28T13:00:00.000Z',
        startPhase: undefined,
      },
    );
  });

  it('signals blocked workflows instead of starting duplicates and recovers duplicate-start races safely', async () => {
    const input = buildWorkflowInput();
    const candidate = buildCandidate({ issueNumber: 7, boardStatusName: 'Ready' });
    const calls: string[] = [];
    let inspectCount = 0;

    const action = await handleWorkflowTrigger(
      {
        async getWorkflowState(workflowId) {
          calls.push(`state:${workflowId}`);
          inspectCount += 1;
          return inspectCount === 1 ? { kind: 'missing' } : { kind: 'open', blockedReason: 'awaiting_spec_review' };
        },
        async startWorkflow(workflowId, workflowInput) {
          calls.push(`start:${workflowId}:${workflowInput.startPhase}`);
          throw new WorkflowExecutionAlreadyStartedError('Workflow execution already started', workflowId, 'automateTopReadyIssue');
        },
        async signalWorkflow(workflowId, signalName) {
          calls.push(`signal:${workflowId}:${signalName}`);
        },
      },
      input,
      candidate,
    );

    assert.deepStrictEqual(action, { type: 'signal', workflowId: 'ticket-7', signalName: 'specReviewed' });
    assert.deepStrictEqual(calls, [
      'state:ticket-7',
      'start:ticket-7:implement',
      'state:ticket-7',
      'signal:ticket-7:specReviewed',
    ]);
  });

  it('passes configured agent selections through when starting a new workflow', async () => {
    const input = {
      ...buildWorkflowInput(),
      agents: {
        default: { provider: 'codex', config: { model: 'gpt-5.4' } },
        review: { provider: 'claude', config: { model: 'claude-sonnet-4-6' } },
      },
    };
    let startedInput: AutomateReadyIssueInput | undefined;

    const action = await handleWorkflowTrigger(
      {
        async getWorkflowState() {
          return { kind: 'missing' };
        },
        async startWorkflow(_workflowId, workflowInput) {
          startedInput = workflowInput;
        },
        async signalWorkflow() {
          throw new Error('signalWorkflow should not run when starting a workflow');
        },
      },
      input,
      buildCandidate({ issueNumber: 7, boardStatusName: 'Ready' }),
    );

    assert.deepStrictEqual(action, { type: 'start', workflowId: 'ticket-7', startPhase: 'implement' });
    assert.deepStrictEqual(startedInput, { ...input, startPhase: 'implement' });
  });

  it('turns signal races where the workflow disappears into a noop', async () => {
    const input = buildWorkflowInput();
    const action = await handleWorkflowTrigger(
      {
        async getWorkflowState() {
          return { kind: 'open', blockedReason: 'review_escalation' };
        },
        async startWorkflow() {
          throw new Error('startWorkflow should not run for signal-only intake');
        },
        async signalWorkflow(workflowId) {
          throw new WorkflowNotFoundError('Workflow not found', workflowId, undefined);
        },
      },
      input,
      buildCandidate({ issueNumber: 7, boardStatusName: 'In review' }),
    );

    assert.deepStrictEqual(action, { type: 'noop', workflowId: 'ticket-7', reason: 'workflow_not_found' });
  });

  it('fails explicitly when the selected issue repo does not match the configured target binding', async () => {
    await assert.rejects(
      () => handleWorkflowTrigger(
        {
          async getWorkflowState() {
            throw new Error('getWorkflowState should not run for repo mismatch');
          },
          async startWorkflow() {
            throw new Error('startWorkflow should not run for repo mismatch');
          },
          async signalWorkflow() {
            throw new Error('signalWorkflow should not run for repo mismatch');
          },
        },
        {
          ...buildWorkflowInput(),
          targetId: 'acme-web',
          expectedRepoOwner: 'acme',
          expectedRepoName: 'web',
        },
        buildCandidate({ issueNumber: 7, boardStatusName: 'Ready' }),
      ),
      /target "acme-web" is bound to acme\/web/,
    );
  });

  it('caps pickup actions across both starts and signals', async () => {
    const input = buildWorkflowInput();
    const calls: string[] = [];
    const actions = await runPickupIntake(
      {
        async getWorkflowState(workflowId) {
          calls.push(`state:${workflowId}`);
          if (workflowId === 'ticket-5') return { kind: 'open', blockedReason: 'specify_needs_input' };
          return { kind: 'missing' };
        },
        async startWorkflow(workflowId, workflowInput) {
          calls.push(`start:${workflowId}:${workflowInput.startPhase}`);
        },
        async signalWorkflow(workflowId, signalName) {
          calls.push(`signal:${workflowId}:${signalName}`);
        },
      },
      input,
      [
        buildCandidate({ issueNumber: 5, boardStatusName: 'Backlog', createdAt: '2026-04-28T08:00:00.000Z', startPhase: 'specify' }),
        buildCandidate({ issueNumber: 6, boardStatusName: 'Ready', createdAt: '2026-04-28T09:00:00.000Z', startPhase: 'implement' }),
        buildCandidate({ issueNumber: 7, boardStatusName: 'Ready', createdAt: '2026-04-28T10:00:00.000Z', startPhase: 'implement' }),
      ],
      2,
    );

    assert.deepStrictEqual(actions, [
      { type: 'signal', workflowId: 'ticket-5', signalName: 'specifyRetry' },
      { type: 'start', workflowId: 'ticket-6', startPhase: 'implement' },
    ]);
    assert.deepStrictEqual(calls, [
      'state:ticket-5',
      'signal:ticket-5:specifyRetry',
      'state:ticket-6',
      'start:ticket-6:implement',
    ]);
  });

  it('keeps repeated pickup ticks idempotent for already-running workflows', async () => {
    const input = buildWorkflowInput();
    const candidate = buildCandidate({ issueNumber: 8, boardStatusName: 'Ready', createdAt: '2026-04-28T08:00:00.000Z', startPhase: 'implement' });
    const states = new Map<string, { kind: 'missing' } | { kind: 'open'; blockedReason: null }>([['ticket-8', { kind: 'missing' }]]);
    const calls: string[] = [];
    const deps = {
      async getWorkflowState(workflowId: string) {
        calls.push(`state:${workflowId}`);
        return states.get(workflowId) ?? { kind: 'missing' as const };
      },
      async startWorkflow(workflowId: string, workflowInput: AutomateReadyIssueInput) {
        calls.push(`start:${workflowId}:${workflowInput.startPhase}`);
        states.set(workflowId, { kind: 'open', blockedReason: null });
      },
      async signalWorkflow(workflowId: string, signalName: string) {
        calls.push(`signal:${workflowId}:${signalName}`);
      },
    };

    assert.deepStrictEqual(await runPickupIntake(deps, input, [candidate], 1), [
      { type: 'start', workflowId: 'ticket-8', startPhase: 'implement' },
    ]);
    assert.deepStrictEqual(await runPickupIntake(deps, input, [candidate], 1), []);
    assert.deepStrictEqual(calls, [
      'state:ticket-8',
      'start:ticket-8:implement',
      'state:ticket-8',
    ]);
  });
});

function buildWorkflowInput(): AutomateReadyIssueInput {
  return { projectOwner: 'Mugenor', projectNumber: 1 };
}

function buildListedIssue(overrides: {
  issueNumber: number;
  statusName: 'Backlog' | 'Ready';
  createdAt: string;
}): SelectedProjectIssue & { currentStatusName: 'Backlog' | 'Ready'; createdAt: string } {
  const base = buildSelectedIssue();
  return {
    ...base,
    projectItemId: `item-${overrides.issueNumber}`,
    issueNumber: overrides.issueNumber,
    issueTitle: `Issue ${overrides.issueNumber}`,
    taskDescription: `Task ${overrides.issueNumber}`,
    issueUrl: `https://github.com/Mugenor/orchestrator-testing/issues/${overrides.issueNumber}`,
    currentStatusName: overrides.statusName,
    createdAt: overrides.createdAt,
  };
}

function buildCandidate(overrides: {
  issueNumber: number;
  boardStatusName: 'Backlog' | 'Ready' | 'In review';
  createdAt?: string;
  startPhase?: 'specify' | 'implement';
}): IntakeCandidate {
  const issue = buildListedIssue({
    issueNumber: overrides.issueNumber,
    statusName: overrides.boardStatusName === 'Backlog' ? 'Backlog' : 'Ready',
    createdAt: overrides.createdAt ?? '2026-04-28T09:00:00.000Z',
  });
  return {
    issue,
    boardStatusName: overrides.boardStatusName,
    createdAt: overrides.createdAt ?? issue.createdAt,
    startPhase: overrides.startPhase,
  };
}