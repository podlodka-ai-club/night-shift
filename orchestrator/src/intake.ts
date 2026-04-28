import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/common';
import type { WorkflowClient } from '@temporalio/client';
import {
  BLOCKED_REASON_BOARD_SIGNAL_RULES,
  TASK_QUEUE,
  type AutomateReadyIssueInput,
  type ListedProjectIssue,
  type ListProjectIssuesByStatusInput,
  type ProjectStatusName,
  type SelectedProjectIssue,
  type WorkflowBlockedReason,
  type WorkflowPhase,
  type WorkflowSignalName,
} from './shared';
import {
  automateTopReadyIssue,
  getBlockedReasonQuery,
  implementRetrySignal,
  resumeSignal,
  specReviewedSignal,
  specifyRetrySignal,
} from './workflows';

type StartPhase = Extract<WorkflowPhase, 'specify' | 'implement'>;

export interface IntakeCandidate {
  issue: SelectedProjectIssue | ListedProjectIssue;
  boardStatusName: ProjectStatusName;
  createdAt: string;
  startPhase?: StartPhase;
}

export type IntakeWorkflowState = { kind: 'missing' } | { kind: 'closed' } | { kind: 'open'; blockedReason: WorkflowBlockedReason | null };
export type WorkflowTriggerAction =
  | { type: 'start'; workflowId: string; startPhase: StartPhase }
  | { type: 'signal'; workflowId: string; signalName: WorkflowSignalName }
  | { type: 'noop'; workflowId: string; reason: 'already_running' | 'blocked_reason_mismatch' | 'unsupported_start_status' | 'workflow_not_found' };

export interface WorkflowTriggerDeps {
  getWorkflowState(workflowId: string): Promise<IntakeWorkflowState>;
  startWorkflow(workflowId: string, workflowInput: AutomateReadyIssueInput): Promise<void>;
  signalWorkflow(workflowId: string, signalName: WorkflowSignalName): Promise<void>;
}

export interface IntakeProjectDeps {
  listProjectIssuesByStatus(input: ListProjectIssuesByStatusInput): Promise<ListedProjectIssue[]>;
}

export function buildIssueWorkflowId(issueNumber: number): string {
  return `ticket-${issueNumber}`;
}

export function buildPickupCandidates(backlogIssues: ListedProjectIssue[], readyIssues: ListedProjectIssue[]): IntakeCandidate[] {
  return [...backlogIssues.map((issue) => ({ issue, boardStatusName: 'Backlog' as const, createdAt: issue.createdAt, startPhase: 'specify' as const })),
    ...readyIssues.map((issue) => ({ issue, boardStatusName: 'Ready' as const, createdAt: issue.createdAt, startPhase: 'implement' as const }))]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.issue.issueNumber - right.issue.issueNumber);
}

export function buildManualCandidate(issue: ListedProjectIssue): IntakeCandidate {
  // Manual intake may target `In review` so the handler can send `resume`, but those items must never
  // start a fresh workflow. Leaving startPhase undefined makes that intent explicit at the candidate layer.
  return {
    issue,
    boardStatusName: issue.currentStatusName,
    createdAt: issue.createdAt,
    startPhase: issue.currentStatusName === 'Backlog' ? 'specify' : issue.currentStatusName === 'Ready' ? 'implement' : undefined,
  };
}

export async function loadPickupCandidates(
  deps: IntakeProjectDeps,
  workflowInput: AutomateReadyIssueInput,
): Promise<IntakeCandidate[]> {
  const [backlogIssues, readyIssues] = await Promise.all([
    deps.listProjectIssuesByStatus({ ...workflowInput, statusNames: ['Backlog'] }),
    deps.listProjectIssuesByStatus({ ...workflowInput, statusNames: ['Ready'] }),
  ]);
  return buildPickupCandidates(backlogIssues, readyIssues);
}

export async function loadManualCandidate(
  deps: IntakeProjectDeps,
  workflowInput: AutomateReadyIssueInput,
  statusName: ProjectStatusName,
): Promise<IntakeCandidate | undefined> {
  // `listProjectIssuesByStatus` already returns items sorted by createdAt, so the first candidate is the
  // canonical top item for the requested board status.
  const issues = await deps.listProjectIssuesByStatus({ ...workflowInput, statusNames: [statusName] });
  return issues[0] ? buildManualCandidate(issues[0]) : undefined;
}

export function resolveWorkflowTriggerAction(input: {
  boardStatusName: ProjectStatusName;
  workflowId: string;
  workflowState: IntakeWorkflowState;
}): WorkflowTriggerAction {
  const { workflowState } = input;
  if (workflowState.kind !== 'open') {
    if (input.boardStatusName === 'Backlog') return { type: 'start', workflowId: input.workflowId, startPhase: 'specify' };
    if (input.boardStatusName === 'Ready') return { type: 'start', workflowId: input.workflowId, startPhase: 'implement' };
    return { type: 'noop', workflowId: input.workflowId, reason: 'unsupported_start_status' };
  }

  const matchingRule = BLOCKED_REASON_BOARD_SIGNAL_RULES.find(
    (rule) => rule.blockedReason === workflowState.blockedReason && rule.boardStatusName === input.boardStatusName,
  );
  if (matchingRule) return { type: 'signal', workflowId: input.workflowId, signalName: matchingRule.signalName };
  return { type: 'noop', workflowId: input.workflowId, reason: workflowState.blockedReason ? 'blocked_reason_mismatch' : 'already_running' };
}

export async function handleWorkflowTrigger(
  deps: WorkflowTriggerDeps,
  workflowInput: AutomateReadyIssueInput,
  candidate: IntakeCandidate,
): Promise<WorkflowTriggerAction> {
  const workflowId = buildIssueWorkflowId(candidate.issue.issueNumber);
  const initialAction = resolveWorkflowTriggerAction({ boardStatusName: candidate.boardStatusName, workflowId, workflowState: await deps.getWorkflowState(workflowId) });
  if (initialAction.type === 'signal') {
    try {
      await deps.signalWorkflow(workflowId, initialAction.signalName);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return { type: 'noop', workflowId, reason: 'workflow_not_found' };
      }
      throw error;
    }
    return initialAction;
  }
  if (initialAction.type === 'noop') return initialAction;

  try {
    await deps.startWorkflow(workflowId, { ...workflowInput, startPhase: initialAction.startPhase });
    return initialAction;
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    const reroutedAction = resolveWorkflowTriggerAction({ boardStatusName: candidate.boardStatusName, workflowId, workflowState: await deps.getWorkflowState(workflowId) });
    if (reroutedAction.type === 'signal') {
      try {
        await deps.signalWorkflow(workflowId, reroutedAction.signalName);
      } catch (signalError) {
        if (signalError instanceof WorkflowNotFoundError) {
          return { type: 'noop', workflowId, reason: 'workflow_not_found' };
        }
        throw signalError;
      }
    }
    return reroutedAction;
  }
}

export async function runPickupIntake(
  deps: WorkflowTriggerDeps,
  workflowInput: AutomateReadyIssueInput,
  candidates: IntakeCandidate[],
  maxActions: number,
): Promise<Array<Extract<WorkflowTriggerAction, { type: 'start' | 'signal' }>>> {
  const actions: Array<Extract<WorkflowTriggerAction, { type: 'start' | 'signal' }>> = [];
  for (const candidate of candidates) {
    if (actions.length >= maxActions) break;
    const action = await handleWorkflowTrigger(deps, workflowInput, candidate);
    if (action.type !== 'noop') actions.push(action);
  }
  return actions;
}

export function createTemporalWorkflowTriggerDeps(client: Pick<WorkflowClient, 'getHandle' | 'start'>): WorkflowTriggerDeps {
  return {
    async getWorkflowState(workflowId) {
      const handle = client.getHandle<typeof automateTopReadyIssue>(workflowId);
      try {
        const description = await handle.describe();
        if (description.status.name !== 'RUNNING') return { kind: 'closed' };
        return { kind: 'open', blockedReason: await handle.query(getBlockedReasonQuery) };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return { kind: 'missing' };
        throw error;
      }
    },
    async startWorkflow(workflowId, workflowInput) {
      await client.start(automateTopReadyIssue, { taskQueue: TASK_QUEUE, workflowId, args: [workflowInput] });
    },
    async signalWorkflow(workflowId, signalName) {
      const handle = client.getHandle<typeof automateTopReadyIssue>(workflowId);
      await handle.signal(resolveSignalDefinition(signalName));
    },
  };
}

function resolveSignalDefinition(signalName: WorkflowSignalName) {
  switch (signalName) {
    case 'specifyRetry': return specifyRetrySignal;
    case 'specReviewed': return specReviewedSignal;
    case 'implementRetry': return implementRetrySignal;
    case 'resume': return resumeSignal;
  }
}