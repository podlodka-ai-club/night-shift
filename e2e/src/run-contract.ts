import { CANONICAL_PROJECT_STATUS_NAMES, READY_ISSUE_STATUS_SEQUENCE } from '../../orchestrator/lib/shared';

export const REQUIRED_STATUS_SEQUENCE = READY_ISSUE_STATUS_SEQUENCE;
const CANONICAL_PROJECT_STATUS_NAME_SET = new Set<string>(CANONICAL_PROJECT_STATUS_NAMES);

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

  let nextRequiredStatusIndex = 0;

  for (const observedStatus of observedStatuses) {
    const requiredStatus = REQUIRED_STATUS_SEQUENCE[nextRequiredStatusIndex];
    if (observedStatus !== requiredStatus) {
      continue;
    }

    nextRequiredStatusIndex += 1;
    if (nextRequiredStatusIndex === REQUIRED_STATUS_SEQUENCE.length) {
      return;
    }
  }

  throw new Error(
    `Observed statuses did not include the required sequence: ${REQUIRED_STATUS_SEQUENCE.join(' -> ')}. Got: ${observedStatuses.join(', ') || '(none)'}`,
  );
}