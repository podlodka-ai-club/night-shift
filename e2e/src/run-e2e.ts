import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { createActivities, createActivityDependencies } from '../../orchestrator/lib/activities';
import { createGitHubActivities } from '../../orchestrator/lib/activity-github';
import type { ActivityRuntimes } from '../../orchestrator/lib/activity-deps';
import {
  TASK_QUEUE,
  WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME,
  type AutomateReadyIssueInput,
  type AutomateReadyIssueResult,
  type ProjectStatusName,
  type SelectedProjectIssue,
} from '../../orchestrator/lib/shared';
import {
  buildIssueWorkflowId,
  createTemporalWorkflowTriggerDeps,
  handleWorkflowTrigger,
  type IntakeCandidate,
  loadPickupCandidates,
  loadManualCandidate,
  runPickupIntake,
} from '../../orchestrator/lib/intake';
import { pickupWorkflow } from '../../orchestrator/lib/workflows';
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
  buildSelectedIssueChangeName,
  getProjectItemStatusName,
  seedIssueInProject,
  type CleanupReport,
  type SeededIssue,
} from './live-github';

const STATUS_POLL_INTERVAL_MS = 1_000;

export const FAKE_E2E_QUALITY_GATE_FILE = {
  path: 'Makefile',
  content: [
    '.PHONY: check',
    'check:',
    '\t@echo "fake e2e quality gate passed"',
  ].join('\n'),
};

export function resolveStartPhase(agentMode: E2EConfig['agentMode']): 'implement' | 'specify' {
  return agentMode === 'fake' ? 'implement' : 'specify';
}

export function resolveSeedStatus(agentMode: E2EConfig['agentMode']): ProjectStatusName {
  return resolveStartPhase(agentMode) === 'specify' ? 'Backlog' : 'Ready';
}

export interface E2ERunSummary {
  runId: string;
  workflowId: string;
  agentMode: 'real' | 'fake';
  issueUrl?: string;
  pullRequestUrl?: string;
  workflowCurrentDetails?: string;
  assistantProgressCurrentDetails?: string;
  observedStatuses: string[];
  cleanupAttempted: boolean;
  cleanupReport?: CleanupReport;
  preservedArtifacts: boolean;
}

export interface WorkflowRunObservation {
  workflowResult: AutomateReadyIssueResult;
  workflowCurrentDetails?: string;
  assistantProgressCurrentDetails?: string;
}

export async function runConfiguredIntake(
  config: Pick<E2EConfig, 'intakeMode'>,
  deps: {
    executePickupWorkflow(): Promise<void>;
    executeManualIntake(): Promise<void>;
    awaitWorkflowResult(): Promise<AutomateReadyIssueResult>;
  },
): Promise<AutomateReadyIssueResult> {
  if (config.intakeMode === 'pickup') {
    await deps.executePickupWorkflow();
  } else {
    await deps.executeManualIntake();
  }
  return deps.awaitWorkflowResult();
}

export async function runE2E(env: NodeJS.ProcessEnv = process.env): Promise<E2ERunSummary> {
  const config = parseE2EConfig(env);
  const runId = randomUUID().slice(0, 8);
  const branchPrefix = `orchestrator-e2e-${runId}`;
  const githubDeps = createGitHubDeps(config.githubToken);
  const startPhase = resolveStartPhase(config.agentMode);
  const seedStatus = resolveSeedStatus(config.agentMode);

  let seededIssue: SeededIssue | undefined;
  let selectedIssue: SelectedProjectIssue | undefined;
  let workflowResult: AutomateReadyIssueResult | undefined;
  let workflowCurrentDetails: string | undefined;
  let assistantProgressCurrentDetails: string | undefined;
  let workflowId: string | undefined;
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
      seedStatus,
    );
    selectedIssue = await assertSeededIssueWillBeSelected(githubDeps, config, seededIssue.issueNumber, startPhase);
    workflowId = buildIssueWorkflowId(selectedIssue.issueNumber);

    observedStatuses = [];
    await recordCurrentProjectItemStatus(githubDeps, seededIssue.projectItemId, observedStatuses);

    const testEnv = await TestWorkflowEnvironment.createLocal();
    try {
      const poller = startStatusPoller(githubDeps, seededIssue.projectItemId, observedStatuses);
      try {
        const workflowObservation = await runWorkflowOnce(testEnv, config, runId, branchPrefix, startPhase, selectedIssue);
        workflowResult = workflowObservation.workflowResult;
        workflowCurrentDetails = workflowObservation.workflowCurrentDetails;
        assistantProgressCurrentDetails = workflowObservation.assistantProgressCurrentDetails;
      } finally {
        observedStatuses = await poller.stop();
        await recordCurrentProjectItemStatus(githubDeps, seededIssue.projectItemId, observedStatuses);
      }
    } finally {
      await testEnv.teardown();
    }

    assertObservedStatusSequence(observedStatuses);
    await assertWorkflowArtifacts(githubDeps, config, seededIssue, selectedIssue, workflowResult);
    if (config.agentMode === 'fake') {
      assertFakeAgentWorkflowCurrentDetails(workflowCurrentDetails, assistantProgressCurrentDetails);
    }
  } catch (error) {
    failure = error;
  }

  if (seededIssue && shouldCleanup(config, failure)) {
    cleanupReport = await cleanupRunArtifacts(githubDeps, config, seededIssue, selectedIssue, branchPrefix, workflowResult);
  }

  const cleanupAttempted = Boolean(seededIssue) && shouldCleanup(config, failure);

  const summary: E2ERunSummary = {
    runId,
    workflowId: workflowId ?? `unresolved-${runId}`,
    agentMode: config.agentMode,
    issueUrl: seededIssue?.issueUrl,
    pullRequestUrl: workflowResult?.pullRequestUrl,
    workflowCurrentDetails,
    assistantProgressCurrentDetails,
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
  runId: string,
  branchPrefix: string,
  startPhase: 'implement' | 'specify',
  selectedIssue: SelectedProjectIssue,
): Promise<WorkflowRunObservation> {
  const baseDeps = createActivityDependencies({
    signalWorkflowProgress: async (workflowId, message) => {
      await testEnv.client.workflow.getHandle(workflowId).signal(WORKFLOW_ACTIVITY_PROGRESS_SIGNAL_NAME, message);
    },
  });
  const agentDeps = config.agentMode === 'fake' ? createFakeAgentDeps(baseDeps) : baseDeps;
  const runtimes: ActivityRuntimes = {
    github: createGitHubDeps(config.githubToken),
    worktree: baseDeps,
    agent: agentDeps,
  };

  if (config.agentMode === 'fake') {
    await seedApprovedSpecBundle(createActivities(runtimes), selectedIssue, branchPrefix);
  }

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('../../orchestrator/lib/workflows'),
    activities: {
      ...createActivities(runtimes),
      async scanPickupCandidates(workflowInput: AutomateReadyIssueInput) {
        return loadPickupCandidates(createGitHubActivities(runtimes.github), workflowInput);
      },
      async startPickupWorkflows(input: {
        workflowInput: AutomateReadyIssueInput;
        candidates: IntakeCandidate[];
        maxActions: number;
      }) {
        return runPickupIntake(
          createTemporalWorkflowTriggerDeps(testEnv.client.workflow),
          input.workflowInput,
          input.candidates,
          input.maxActions,
        );
      },
    },
  });

  return worker.runUntil(async () => {
    const workflowHandle = testEnv.client.workflow.getHandle(buildIssueWorkflowId(selectedIssue.issueNumber));
    let assistantProgressPromise: Promise<string | undefined> | undefined;
    const workflowInput = {
      projectOwner: config.projectOwner,
      projectNumber: config.projectNumber,
      branchPrefix,
    };
    const workflowResult = await runConfiguredIntake(config, {
      async executePickupWorkflow() {
        await testEnv.client.workflow.execute(pickupWorkflow, {
          taskQueue: TASK_QUEUE,
          workflowId: `pickup-e2e-${runId}`,
          args: [{ workflowInput, maxActions: 1 }],
        });
      },
      async executeManualIntake() {
        const candidate = await loadManualCandidate(
          createGitHubActivities(runtimes.github),
          workflowInput,
          startPhase === 'specify' ? 'Backlog' : 'Ready',
        );
        if (!candidate) {
          throw new Error(`Could not resolve a ${startPhase === 'specify' ? 'Backlog' : 'Ready'} intake candidate for the e2e run.`);
        }
        const action = await handleWorkflowTrigger(
          createTemporalWorkflowTriggerDeps(testEnv.client.workflow),
          { ...workflowInput, startPhase },
          candidate,
        );
        if (action.type === 'noop') {
          throw new Error(`E2E intake unexpectedly became a no-op (${action.reason}) for workflow ${action.workflowId}.`);
        }
      },
      async awaitWorkflowResult() {
        const workflowResultPromise = workflowHandle.result();
        assistantProgressPromise =
          config.agentMode === 'fake'
            ? waitForWorkflowCurrentDetailsMatch(
                workflowHandle,
                /Preparing deterministic fake (implementation output|review verdict)\./i,
                workflowResultPromise,
              )
            : Promise.resolve(undefined);
        return workflowResultPromise;
      },
    });

    return {
      workflowResult,
      workflowCurrentDetails: await getWorkflowCurrentDetails(workflowHandle),
      assistantProgressCurrentDetails: await assistantProgressPromise,
    };
  });
}

export function assertFakeAgentWorkflowCurrentDetails(
  currentDetails: string | undefined,
  assistantProgressCurrentDetails: string | undefined,
): void {
  assert.ok(currentDetails, 'Expected the fake-agent workflow run to expose Temporal current details.');
  assert.match(currentDetails, /Recent summaries:/i);
  assert.ok(
    assistantProgressCurrentDetails,
    'Expected to observe assistant-authored fake progress in workflow current details while the workflow was running.',
  );
  assert.match(assistantProgressCurrentDetails, /Preparing deterministic fake (implementation output|review verdict)\./i);
}

async function getWorkflowCurrentDetails(
  workflowHandle: ReturnType<TestWorkflowEnvironment['client']['workflow']['getHandle']>,
): Promise<string | undefined> {
  const workflowMetadata = await workflowHandle.query<{ currentDetails?: unknown }>('__temporal_workflow_metadata');
  return typeof workflowMetadata?.currentDetails === 'string' ? workflowMetadata.currentDetails : undefined;
}

async function waitForWorkflowCurrentDetailsMatch(
  workflowHandle: ReturnType<TestWorkflowEnvironment['client']['workflow']['getHandle']>,
  matcher: RegExp,
  workflowResultPromise: Promise<AutomateReadyIssueResult>,
): Promise<string | undefined> {
  let workflowFinished = false;
  void workflowResultPromise.finally(() => {
    workflowFinished = true;
  });

  while (!workflowFinished) {
    const currentDetails = await getWorkflowCurrentDetailsOrUndefined(workflowHandle);
    if (currentDetails && matcher.test(currentDetails)) {
      return currentDetails;
    }
    await delay(200);
  }

  const currentDetails = await getWorkflowCurrentDetailsOrUndefined(workflowHandle);
  return currentDetails && matcher.test(currentDetails) ? currentDetails : undefined;
}

async function getWorkflowCurrentDetailsOrUndefined(
  workflowHandle: ReturnType<TestWorkflowEnvironment['client']['workflow']['getHandle']>,
): Promise<string | undefined> {
  try {
    return await getWorkflowCurrentDetails(workflowHandle);
  } catch {
    return undefined;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function seedApprovedSpecBundle(
  activities: ReturnType<typeof createActivities>,
  selectedIssue: SelectedProjectIssue,
  branchPrefix: string,
): Promise<void> {
  const worktree = await activities.createWorktreeForIssueIfNeeded({
    issue: selectedIssue,
    branchPrefix,
  });
  const changeName = buildSelectedIssueChangeName(selectedIssue);
  await activities.writeOpenSpecChangeFiles({
    worktree,
    changeName,
    files: [
      { path: 'proposal.md', content: '# Proposal\n\n## Why\n- Seed an approved spec bundle for the fake-agent e2e run.' },
      { path: 'tasks.md', content: '# Tasks\n\n- [x] Approve the fake-agent e2e spec bundle.' },
      { path: 'specs/e2e/spec.md', content: '## ADDED Requirements\n### Requirement: Fake agent e2e implement flow\nThe live fake-agent path MUST start from Ready with an approved spec bundle.' },
    ],
  });
  await activities.writeRepositoryFiles({
    worktree,
    files: [FAKE_E2E_QUALITY_GATE_FILE],
  });
  await activities.commitAndPush({
    worktree,
    commitMessage: `test: seed approved spec bundle for ${selectedIssue.issueNumber}`,
  });
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

      await delay(STATUS_POLL_INTERVAL_MS);
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

if (require.main === module) {
  runE2E().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}