import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { createActivities, createActivityDependencies } from '../../orchestrator/lib/activities';
import type { ActivityRuntimes } from '../../orchestrator/lib/activity-deps';
import { createGitHubActivities } from '../../orchestrator/lib/activity-github';
import { TASK_QUEUE, type AutomateReadyIssueResult, type SelectedProjectIssue } from '../../orchestrator/lib/shared';
import { automateTopReadyIssue, getBlockedReasonQuery, specReviewedSignal } from '../../orchestrator/lib/workflows';
import { parseE2EConfig, type E2EConfig } from './config';
import { createFakeAgentDeps } from './fake-agent';
import {
  assertObservedStatusSequence,
  buildSeedIssueBody,
  buildSeedIssueTitle,
} from './run-contract';
import {
  assertSeededIssueWillBeSelected,
  assertWorkflowArtifacts,
  cleanupRunArtifacts,
  createGitHubDeps,
  getProjectItemStatusName,
  seedIssueInProject,
  type CleanupReport,
  type SeededIssue,
} from './live-github';

const STATUS_POLL_INTERVAL_MS = 1_000;

export interface E2ERunSummary {
  runId: string;
  workflowId: string;
  agentMode: 'real' | 'fake';
  issueUrl?: string;
  pullRequestUrl?: string;
  observedStatuses: string[];
  cleanupAttempted: boolean;
  cleanupReport?: CleanupReport;
  preservedArtifacts: boolean;
}

export async function runE2E(env: NodeJS.ProcessEnv = process.env): Promise<E2ERunSummary> {
  const config = parseE2EConfig(env);
  const runId = randomUUID().slice(0, 8);
  const workflowId = `orchestrator-live-e2e-${runId}`;
  const branchPrefix = `orchestrator-e2e-${runId}`;
  const filePathPrefix = `orchestrator-e2e/${runId}`;
  const githubDeps = createGitHubDeps(config.githubToken);
  const startPhase = config.agentMode === 'fake' ? 'specify' : 'implement';

  let seededIssue: SeededIssue | undefined;
  let selectedIssue: SelectedProjectIssue | undefined;
  let workflowResult: AutomateReadyIssueResult | undefined;
  let observedStatuses: string[] = [];
  let cleanupReport: CleanupReport | undefined;
  let failure: unknown;

  try {
    seededIssue = await seedIssueInProject(
      githubDeps,
      config,
      runId,
      buildSeedIssueTitle(runId),
      buildSeedIssueBody(runId),
      startPhase === 'specify' ? 'Backlog' : 'Ready',
    );
    selectedIssue = await assertSeededIssueWillBeSelected(githubDeps, config, seededIssue.issueNumber, startPhase);

    observedStatuses = [];
    await recordCurrentProjectItemStatus(githubDeps, seededIssue.projectItemId, observedStatuses);

    const testEnv = await TestWorkflowEnvironment.createLocal();
    try {
      const poller = startStatusPoller(githubDeps, seededIssue.projectItemId, observedStatuses);
      try {
        workflowResult = await runWorkflowOnce(testEnv, config, workflowId, branchPrefix, filePathPrefix, startPhase, selectedIssue, observedStatuses);
      } finally {
        observedStatuses = await poller.stop();
        await recordCurrentProjectItemStatus(githubDeps, seededIssue.projectItemId, observedStatuses);
      }
    } finally {
      await testEnv.teardown();
    }

    assertObservedStatusSequence(observedStatuses);
    await assertWorkflowArtifacts(githubDeps, config, seededIssue, selectedIssue, workflowResult);
  } catch (error) {
    failure = error;
  }

  if (seededIssue && shouldCleanup(config, failure)) {
    cleanupReport = await cleanupRunArtifacts(githubDeps, config, seededIssue, selectedIssue, branchPrefix, workflowResult);
  }

  const cleanupAttempted = Boolean(seededIssue) && shouldCleanup(config, failure);

  const summary: E2ERunSummary = {
    runId,
    workflowId,
    agentMode: config.agentMode,
    issueUrl: seededIssue?.issueUrl,
    pullRequestUrl: workflowResult?.pullRequestUrl,
    observedStatuses,
    cleanupAttempted,
    cleanupReport,
    preservedArtifacts: Boolean(seededIssue) && !cleanupAttempted,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failure) {
    throw failure;
  }

  return summary;
}

export function shouldCleanup(config: E2EConfig, failure?: unknown): boolean {
  if (!config.cleanup) {
    return false;
  }
  if (!failure) {
    return true;
  }
  return !config.preserveOnFailure;
}

export function recordObservedStatus(observedStatuses: string[], statusName: string | undefined): void {
  const lastObservedStatus = observedStatuses.at(-1);
  if (!statusName || lastObservedStatus === statusName) {
    return;
  }

  observedStatuses.push(statusName);
}

async function recordCurrentProjectItemStatus(
  githubDeps: ReturnType<typeof createGitHubDeps>,
  projectItemId: string,
  observedStatuses: string[],
): Promise<void> {
  recordObservedStatus(observedStatuses, await getProjectItemStatusName(githubDeps, projectItemId));
}

async function runWorkflowOnce(
  testEnv: TestWorkflowEnvironment,
  config: E2EConfig,
  workflowId: string,
  branchPrefix: string,
  filePathPrefix: string,
  startPhase: 'implement' | 'specify',
  selectedIssue: SelectedProjectIssue,
  observedStatuses: string[],
): Promise<AutomateReadyIssueResult> {
  const baseDeps = createActivityDependencies();
  const agentDeps = config.agentMode === 'fake' ? createFakeAgentDeps(baseDeps) : baseDeps;
  const runtimes: ActivityRuntimes = {
    github: createGitHubDeps(config.githubToken),
    worktree: baseDeps,
    agent: agentDeps,
  };

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('../../orchestrator/lib/workflows'),
    activities: createActivities(runtimes),
  });

  return worker.runUntil(async () => {
    const handle = await testEnv.client.workflow.start(automateTopReadyIssue, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{
        projectOwner: config.projectOwner,
        projectNumber: config.projectNumber,
        branchPrefix,
        filePathPrefix,
        startPhase,
      }],
    });

    if (startPhase === 'specify') {
      await driveSpecifyApprovalGate(handle, runtimes.github, selectedIssue, observedStatuses);
    }

    return handle.result();
  });
}

async function driveSpecifyApprovalGate(
  handle: Awaited<ReturnType<TestWorkflowEnvironment['client']['workflow']['start']>>,
  githubDeps: ReturnType<typeof createGitHubDeps>,
  selectedIssue: SelectedProjectIssue,
  observedStatuses: string[],
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const blockedReason = await handle.query(getBlockedReasonQuery);
    if (blockedReason === 'awaiting_spec_review') {
      recordObservedStatus(observedStatuses, await getProjectItemStatusName(githubDeps, selectedIssue.projectItemId));
      await createGitHubActivities(githubDeps).moveProjectItemStatus({
        projectId: selectedIssue.projectId,
        projectItemId: selectedIssue.projectItemId,
        statusFieldId: selectedIssue.statusFieldId,
        statusOptionId: selectedIssue.readyOptionId,
      });
      recordObservedStatus(observedStatuses, selectedIssue.readyStatusName);
      await handle.signal(specReviewedSignal);
      return;
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }

  throw new Error('Workflow did not reach awaiting_spec_review during the live fake-agent run.');
}

function startStatusPoller(
  githubDeps: ReturnType<typeof createGitHubDeps>,
  projectItemId: string,
  observedStatuses: string[],
): { stop(): Promise<string[]> } {
  let stopped = false;
  let pollError: unknown;

  const loop = (async () => {
    while (!stopped) {
      try {
        recordObservedStatus(observedStatuses, await getProjectItemStatusName(githubDeps, projectItemId));
      } catch (error) {
        pollError = error;
        stopped = true;
        break;
      }

      await sleep(STATUS_POLL_INTERVAL_MS);
    }
  })();

  return {
    async stop(): Promise<string[]> {
      stopped = true;
      await loop;
      if (pollError) {
        throw pollError;
      }
      return observedStatuses;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  runE2E().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}