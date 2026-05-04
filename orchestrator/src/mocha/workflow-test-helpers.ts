import { after, before } from 'mocha';
import assert from 'assert';
import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  DefaultLogger,
  Runtime,
  Worker,
  type Logger,
  type LogLevel,
  type LogMetadata,
} from '@temporalio/worker';
import { automateTopReadyIssue } from '../workflows';
import {
  TASK_QUEUE,
  type AutomateReadyIssueInput,
  type CreatedPullRequest,
  type IssueCommentInput,
  type MoveProjectItemStatusInput,
  type SelectedProjectIssue,
} from '../shared';
import { createEmptyProjectExtensionManifest } from '../project-extension-manifest';

type WorkflowActivities = Record<string, (...args: any[]) => unknown | Promise<unknown>>;
type ExpectedWorkerWarning = RegExp | string;
type WorkflowRunInput = {
  workflowId: string;
  activities: WorkflowActivities;
  expectedWorkerWarnings?: readonly ExpectedWorkerWarning[];
  workflowInput?: Partial<AutomateReadyIssueInput>;
};

let currentExpectedWorkerWarnings: readonly ExpectedWorkerWarning[] = [];

Runtime.install({
  logger: createExpectedWarningFilterLogger(
    new DefaultLogger('INFO'),
    () => currentExpectedWorkerWarnings,
  ),
});

export function createWorkflowTestRig() {
  let testEnv: TestWorkflowEnvironment;

  before(async function () {
    this.timeout(30_000);
    testEnv = await TestWorkflowEnvironment.createLocal();
  });

  after(async function () {
    this.timeout(30_000);
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  async function runWorkflow(input: WorkflowRunInput) {
    const previousExpectedWarnings = currentExpectedWorkerWarnings;
    currentExpectedWorkerWarnings = input.expectedWorkerWarnings ?? [];

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: require.resolve('../workflows'),
        activities: wrapActivitiesWithExpectedFailures(withDefaultWorkflowActivities(input.activities), currentExpectedWorkerWarnings),
      });

      return worker.runUntil(
        testEnv.client.workflow.execute(automateTopReadyIssue, {
          taskQueue: TASK_QUEUE,
          workflowId: input.workflowId,
          args: [buildWorkflowInput(input.workflowInput)],
        }),
      );
    } finally {
      await settleExpectedWarningLogging();
      currentExpectedWorkerWarnings = previousExpectedWarnings;
    }
  }

  async function runWorkflowWithHandle<T>(
    input: WorkflowRunInput,
    callback: (handle: WorkflowHandle<typeof automateTopReadyIssue>) => Promise<T>,
  ): Promise<T> {
    const previousExpectedWarnings = currentExpectedWorkerWarnings;
    currentExpectedWorkerWarnings = input.expectedWorkerWarnings ?? [];

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: require.resolve('../workflows'),
        activities: wrapActivitiesWithExpectedFailures(withDefaultWorkflowActivities(input.activities), currentExpectedWorkerWarnings),
      });

      return worker.runUntil(async () => {
        const handle = await testEnv.client.workflow.start(automateTopReadyIssue, {
          taskQueue: TASK_QUEUE,
          workflowId: input.workflowId,
          args: [buildWorkflowInput(input.workflowInput)],
        });

        return callback(handle);
      });
    } finally {
      await settleExpectedWarningLogging();
      currentExpectedWorkerWarnings = previousExpectedWarnings;
    }
  }

  async function runWithWorkflowClient<T>(
    input: WorkflowRunInput,
    callback: (workflowClient: typeof testEnv.client.workflow) => Promise<T>,
  ): Promise<T> {
    const previousExpectedWarnings = currentExpectedWorkerWarnings;
    currentExpectedWorkerWarnings = input.expectedWorkerWarnings ?? [];

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: require.resolve('../workflows'),
        activities: wrapActivitiesWithExpectedFailures(withDefaultWorkflowActivities(input.activities), currentExpectedWorkerWarnings),
      });

      return worker.runUntil(async () => callback(testEnv.client.workflow));
    } finally {
      await settleExpectedWarningLogging();
      currentExpectedWorkerWarnings = previousExpectedWarnings;
    }
  }

  return { runWorkflow, runWorkflowWithHandle, runWithWorkflowClient };
}

function buildWorkflowInput(overrides: Partial<AutomateReadyIssueInput> | undefined): AutomateReadyIssueInput {
  return {
    projectOwner: 'Mugenor',
    projectNumber: 1,
    ...overrides,
  };
}

function wrapActivitiesWithExpectedFailures(
  activities: WorkflowActivities,
  expectedWarnings: readonly ExpectedWorkerWarning[],
): WorkflowActivities {
  return Object.fromEntries(
    Object.entries(activities).map(([name, activity]) => [
      name,
      async (...args: any[]) => {
        try {
          return await activity(...args);
        } catch (error) {
          if (!matchesExpectedWorkerWarning(expectedWarnings, error)) throw error;
          throw ApplicationFailure.fromError(error, {
            category: ApplicationFailureCategory.BENIGN,
          });
        }
      },
    ]),
  );
}

function withDefaultWorkflowActivities(activities: WorkflowActivities): WorkflowActivities {
  return {
    cleanupWorktree: async () => undefined,
    listOpenPullRequestFeedback: async () => ({ reviewBodies: [], reviewComments: [] }),
    loadProjectExtensionManifest: async () => createEmptyProjectExtensionManifest(),
    ...activities,
  };
}

export function createExpectedWarningFilterLogger(
  baseLogger: Logger,
  getExpectedWarnings: () => readonly ExpectedWorkerWarning[],
): Logger {
  const log = (level: LogLevel, message: string, meta?: LogMetadata) => {
    if (shouldSuppressExpectedWorkerWarning(level, message, meta, getExpectedWarnings())) return;
    baseLogger.log(level, message, meta);
  };

  return {
    log,
    trace: (message, meta) => log('TRACE', message, meta),
    debug: (message, meta) => log('DEBUG', message, meta),
    info: (message, meta) => log('INFO', message, meta),
    warn: (message, meta) => log('WARN', message, meta),
    error: (message, meta) => log('ERROR', message, meta),
  };
}

function shouldSuppressExpectedWorkerWarning(
  level: LogLevel,
  message: string,
  meta: LogMetadata | undefined,
  expectedWarnings: readonly ExpectedWorkerWarning[],
): boolean {
  if (level !== 'WARN' || expectedWarnings.length === 0) return false;
  if (meta?.sdkComponent !== 'worker' && meta?.sdkComponent !== 'workflow') return false;

  const searchableText = [
    message,
    typeof meta.activityType === 'string' ? meta.activityType : '',
    typeof meta.workflowId === 'string' ? meta.workflowId : '',
    describeLogField(meta.error),
    describeLogField(meta.cause),
  ].join('\n');

  return matchesExpectedWorkerWarningText(expectedWarnings, searchableText);
}

function describeLogField(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return String(value);
}

function matchesExpectedWorkerWarning(
  expectedWarnings: readonly ExpectedWorkerWarning[],
  error: unknown,
): boolean {
  return matchesExpectedWorkerWarningText(expectedWarnings, describeLogField(error));
}

function matchesExpectedWorkerWarningText(
  expectedWarnings: readonly ExpectedWorkerWarning[],
  searchableText: string,
): boolean {
  return expectedWarnings.some((expectedWarning) => {
    if (typeof expectedWarning === 'string') return searchableText.includes(expectedWarning);
    expectedWarning.lastIndex = 0;
    return expectedWarning.test(searchableText);
  });
}

async function settleExpectedWarningLogging(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  Runtime.instance().flushLogs();
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