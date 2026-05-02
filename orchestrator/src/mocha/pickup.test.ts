import assert from 'assert';
import { describe, it } from 'mocha';
import type { AutomateReadyIssueInput, SelectedProjectIssue } from '../shared';
import { runScheduledPickup } from '../pickup';
import { buildSelectedIssue } from './activity-test-helpers';

describe('scheduled pickup helper', () => {
  it('loads backlog + ready candidates and applies the shared intake cap', async () => {
    const input = buildWorkflowInput();
    const calls: string[] = [];

    const actions = await runScheduledPickup(
      {
        async listProjectIssuesByStatus(request) {
          calls.push(`list:${request.statusNames.join('|')}`);
          if (request.statusNames[0] === 'Backlog') {
            return [buildListedIssue({ issueNumber: 5, statusName: 'Backlog', createdAt: '2026-04-28T08:00:00.000Z' })];
          }
          return [
            buildListedIssue({ issueNumber: 6, statusName: 'Ready', createdAt: '2026-04-28T09:00:00.000Z' }),
            buildListedIssue({ issueNumber: 7, statusName: 'Ready', createdAt: '2026-04-28T10:00:00.000Z' }),
          ];
        },
        async getWorkflowState(workflowId) {
          calls.push(`state:${workflowId}`);
          return workflowId === 'ticket-5'
            ? { kind: 'open' as const, blockedReason: 'specify_needs_input' }
            : { kind: 'missing' as const };
        },
        async startWorkflow(workflowId, workflowInput) {
          calls.push(`start:${workflowId}:${workflowInput.startPhase}`);
        },
        async signalWorkflow(workflowId, signalName) {
          calls.push(`signal:${workflowId}:${signalName}`);
        },
      },
      input,
      2,
    );

    assert.deepStrictEqual(actions, [
      { type: 'signal', workflowId: 'ticket-5', signalName: 'specifyRetry' },
      { type: 'start', workflowId: 'ticket-6', startPhase: 'implement' },
    ]);
    assert.deepStrictEqual(calls, [
      'list:Backlog',
      'list:Ready',
      'state:ticket-5',
      'signal:ticket-5:specifyRetry',
      'state:ticket-6',
      'start:ticket-6:implement',
    ]);
  });

  it('returns an empty action list when pickup finds no eligible items', async () => {
    const actions = await runScheduledPickup(
      {
        async listProjectIssuesByStatus() {
          return [];
        },
        async getWorkflowState() {
          throw new Error('getWorkflowState should not run when there are no pickup candidates');
        },
        async startWorkflow() {
          throw new Error('startWorkflow should not run when there are no pickup candidates');
        },
        async signalWorkflow() {
          throw new Error('signalWorkflow should not run when there are no pickup candidates');
        },
      },
      buildWorkflowInput(),
      5,
    );

    assert.deepStrictEqual(actions, []);
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