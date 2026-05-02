import {
  loadPickupCandidates,
  runPickupIntake,
  type IntakeCandidate,
  type IntakeProjectDeps,
  type WorkflowTriggerDeps,
} from './intake';
import type { AutomateReadyIssueInput } from './shared';

export interface PickupWorkflowInput {
  workflowInput: AutomateReadyIssueInput;
  maxActions: number;
}

export interface ScheduledPickupDeps extends IntakeProjectDeps, WorkflowTriggerDeps {}

export async function runScheduledPickup(
  deps: ScheduledPickupDeps,
  workflowInput: AutomateReadyIssueInput,
  maxActions: number,
): Promise<Array<Extract<Awaited<ReturnType<typeof runPickupIntake>>[number], { type: 'start' | 'signal' }>>> {
  return runPickupIntake(deps, workflowInput, await loadPickupCandidates(deps, workflowInput), maxActions);
}

export type PickupWorkflowCandidates = IntakeCandidate[];