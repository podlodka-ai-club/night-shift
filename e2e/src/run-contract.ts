import { CANONICAL_PROJECT_STATUS_NAMES, READY_ISSUE_STATUS_SEQUENCE } from '../../orchestrator/lib/shared';

export const REQUIRED_STATUS_SEQUENCE = READY_ISSUE_STATUS_SEQUENCE;
export const REQUIRED_REVIEW_RERUN_STATUS_SEQUENCE = ['Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Ready to merge'] as const;
export const REQUIRED_IMPLEMENT_ESCALATION_RECOVERY_SEQUENCE = ['Ready', 'In progress', 'Escalated', 'Ready', 'In progress', 'In review', 'Ready to merge'] as const;
export const REQUIRED_SPECIFY_ESCALATION_RECOVERY_SEQUENCE = ['Backlog', 'Refinement', 'Escalated', 'Backlog', 'Refinement', 'Refined', 'Ready', 'In progress', 'In review', 'Ready to merge'] as const;
export const REQUIRED_REVIEW_ONLY_ESCALATION_RECOVERY_SEQUENCE = ['Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Ready', 'In progress', 'In review', 'Escalated', 'In review', 'Ready to merge'] as const;
export const REQUIRED_ESCALATION_HUMAN_FALLBACK_SEQUENCE = ['Ready', 'In progress', 'Escalated', 'Blocked'] as const;
const CANONICAL_PROJECT_STATUS_NAME_SET = new Set<string>(CANONICAL_PROJECT_STATUS_NAMES);
const ALLOWED_ESCALATION_RESUME_TARGETS = new Set(['Backlog', 'Ready', 'In review', 'Blocked']);

export function buildSeedIssueTitle(runId: string): string {
  return `[e2e] orchestrator live test ${runId}`;
}

export function buildSeedIssueBody(runId: string): string {
  const runMarkerInstruction = `When generating commit and pull request metadata, include the run marker \`${runId}\` somewhere in the metadata.`;

  return [
    'This issue was created by the orchestrator live e2e harness.',
    'Create a small repository change that is easy to verify.',
    runMarkerInstruction,
    '',
    `E2E_RUN_MARKER: ${runId}`,
  ].join('\n');
}

export function assertObservedStatusSequence(observedStatuses: string[]): void {
  const nonCanonicalStatuses = observedStatuses.filter((statusName) => !CANONICAL_PROJECT_STATUS_NAME_SET.has(statusName));
  if (nonCanonicalStatuses.length > 0) {
    throw new Error(`Observed non-canonical board statuses: ${nonCanonicalStatuses.join(', ')}`);
  }

  assertAllowedEscalationTransitions(observedStatuses);

  if (includesRequiredSequence(observedStatuses, REQUIRED_STATUS_SEQUENCE)) {
    return;
  }

  if (includesRequiredSequence(observedStatuses, REQUIRED_REVIEW_RERUN_STATUS_SEQUENCE)) {
    return;
  }

  if (includesRequiredSequence(observedStatuses, REQUIRED_IMPLEMENT_ESCALATION_RECOVERY_SEQUENCE)) {
    return;
  }

  if (includesRequiredSequence(observedStatuses, REQUIRED_SPECIFY_ESCALATION_RECOVERY_SEQUENCE)) {
    return;
  }

  if (includesRequiredSequence(observedStatuses, REQUIRED_REVIEW_ONLY_ESCALATION_RECOVERY_SEQUENCE)) {
    return;
  }

  if (includesRequiredSequence(observedStatuses, REQUIRED_ESCALATION_HUMAN_FALLBACK_SEQUENCE)) {
    return;
  }

  throw new Error(
    `Observed statuses did not include an allowed sequence: ${[
      REQUIRED_STATUS_SEQUENCE,
      REQUIRED_REVIEW_RERUN_STATUS_SEQUENCE,
      REQUIRED_IMPLEMENT_ESCALATION_RECOVERY_SEQUENCE,
      REQUIRED_SPECIFY_ESCALATION_RECOVERY_SEQUENCE,
      REQUIRED_REVIEW_ONLY_ESCALATION_RECOVERY_SEQUENCE,
      REQUIRED_ESCALATION_HUMAN_FALLBACK_SEQUENCE,
    ].map((sequence) => sequence.join(' -> ')).join(' OR ')}. Got: ${observedStatuses.join(', ') || '(none)'}`,
  );
}

function includesRequiredSequence(observedStatuses: readonly string[], requiredSequence: readonly string[]): boolean {
  let nextRequiredStatusIndex = 0;

  for (const observedStatus of observedStatuses) {
    const requiredStatus = requiredSequence[nextRequiredStatusIndex];
    if (observedStatus !== requiredStatus) {
      continue;
    }

    nextRequiredStatusIndex += 1;
    if (nextRequiredStatusIndex === requiredSequence.length) {
      return true;
    }
  }

  return false;
}

function assertAllowedEscalationTransitions(observedStatuses: readonly string[]): void {
  for (let index = 0; index < observedStatuses.length; index += 1) {
    if (observedStatuses[index] !== 'Escalated') {
      continue;
    }

    const nextDistinctStatus = observedStatuses.slice(index + 1).find((status) => status !== 'Escalated');
    if (nextDistinctStatus === undefined) {
      continue;
    }

    if (!ALLOWED_ESCALATION_RESUME_TARGETS.has(nextDistinctStatus)) {
      throw new Error(`Observed invalid Escalated transition: Escalated -> ${nextDistinctStatus}`);
    }
  }
}