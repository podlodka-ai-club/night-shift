import { after, before } from 'mocha';
import assert from 'assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { automateTopReadyIssue } from '../workflows';
import {
  TASK_QUEUE,
  type CreatedPullRequest,
  type IssueCommentInput,
  type MoveProjectItemStatusInput,
  type SelectedProjectIssue,
} from '../shared';

type WorkflowActivities = Record<string, (...args: any[]) => unknown | Promise<unknown>>;

export function createWorkflowTestRig() {
  let testEnv: TestWorkflowEnvironment;

  before(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  });

  after(async () => {
    await testEnv.teardown();
  });

  async function runWorkflow(input: { workflowId: string; activities: WorkflowActivities }) {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../workflows'),
      activities: input.activities,
    });

    return worker.runUntil(
      testEnv.client.workflow.execute(automateTopReadyIssue, {
        taskQueue: TASK_QUEUE,
        workflowId: input.workflowId,
        args: [{ projectOwner: 'Mugenor', projectNumber: 1 }],
      }),
    );
  }

  return { runWorkflow };
}

export function assertWorkflowActivityFailure(error: unknown, expectedCause: RegExp): true {
  assert.match(String(error), /Workflow execution failed/);
  const workflowCause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  const activityCause =
    workflowCause && typeof workflowCause === 'object'
      ? (workflowCause as { cause?: unknown }).cause
      : undefined;
  assert.match(String(activityCause), expectedCause);
  return true;
}

export function buildIssueCommentInput(
  issue: SelectedProjectIssue,
  pullRequest: CreatedPullRequest,
): IssueCommentInput {
  return {
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    issueNumber: issue.issueNumber,
    pullRequestUrl: pullRequest.pullRequestUrl,
  };
}

export function buildStatusUpdateInput(
  issue: SelectedProjectIssue,
  statusOptionId: string,
): MoveProjectItemStatusInput {
  return {
    projectId: issue.projectId,
    projectItemId: issue.projectItemId,
    statusFieldId: issue.statusFieldId,
    statusOptionId,
  };
}