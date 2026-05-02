import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { TASK_QUEUE, type AutomateReadyIssueInput } from '../shared';
import { pickupWorkflow } from '../workflows';

describe('pickup workflow', function () {
  this.timeout(30_000);

  let testEnv: TestWorkflowEnvironment;

  before(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  });

  after(async () => {
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  it('passes scanned candidates and the configured action cap into the starter activity', async () => {
    const workflowInput = buildWorkflowInput();
    const candidates = [{ issue: { issueNumber: 7 }, boardStatusName: 'Ready', createdAt: '2026-04-28T09:00:00.000Z', startPhase: 'implement' as const }];
    const scanCalls: AutomateReadyIssueInput[] = [];
    const startCalls: Array<{ workflowInput: AutomateReadyIssueInput; candidates: typeof candidates; maxActions: number }> = [];

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async scanPickupCandidates(input: AutomateReadyIssueInput) {
          scanCalls.push(input);
          return candidates;
        },
        async startPickupWorkflows(input: { workflowInput: AutomateReadyIssueInput; candidates: typeof candidates; maxActions: number }) {
          startCalls.push(input);
          return [{ type: 'start', workflowId: 'ticket-7', startPhase: 'implement' as const }];
        },
      },
    });

    await worker.runUntil(
      testEnv.client.workflow.execute(pickupWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: 'pickup-workflow-forwarding-test',
        args: [{ workflowInput, maxActions: 2 }],
      }),
    );

    assert.deepStrictEqual(scanCalls, [workflowInput]);
    assert.deepStrictEqual(startCalls, [{ workflowInput, candidates, maxActions: 2 }]);
  });

  it('skips the starter activity when no pickup candidates are found', async () => {
    const workflowInput = buildWorkflowInput();
    let startCallCount = 0;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: {
        async scanPickupCandidates() {
          return [];
        },
        async startPickupWorkflows() {
          startCallCount += 1;
          return [];
        },
      },
    });

    await worker.runUntil(
      testEnv.client.workflow.execute(pickupWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: 'pickup-workflow-empty-scan-test',
        args: [{ workflowInput, maxActions: 3 }],
      }),
    );

    assert.strictEqual(startCallCount, 0);
  });
});

function buildWorkflowInput(): AutomateReadyIssueInput {
  return {
    projectOwner: 'Mugenor',
    projectNumber: 1,
    backlogStatusName: 'Backlog',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    blockedStatusName: 'Blocked',
    branchPrefix: 'orchestrator',
  };
}