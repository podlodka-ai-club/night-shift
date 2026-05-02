import { Client, Connection } from '@temporalio/client';
import type { GitHubActivityDeps } from './activity-deps';
import { createGitHubActivities } from './activity-github';
import {
  createTemporalWorkflowTriggerDeps,
  loadPickupCandidates,
  runPickupIntake,
  type IntakeCandidate,
} from './intake';
import type { ResolvedTemporalEntrypointConfig } from './entrypoint-config';
import type { AutomateReadyIssueInput } from './shared';

export function createPickupActivities(
  githubDeps: GitHubActivityDeps,
  temporal: ResolvedTemporalEntrypointConfig,
) {
  const githubActivities = createGitHubActivities(githubDeps);

  return {
    async scanPickupCandidates(workflowInput: AutomateReadyIssueInput): Promise<IntakeCandidate[]> {
      return loadPickupCandidates(githubActivities, workflowInput);
    },

    async startPickupWorkflows(input: {
      workflowInput: AutomateReadyIssueInput;
      candidates: IntakeCandidate[];
      maxActions: number;
    }) {
      const connection = await Connection.connect({ address: temporal.address });
      try {
        const client = new Client({ connection, namespace: temporal.namespace });
        return await runPickupIntake(
          createTemporalWorkflowTriggerDeps(client.workflow),
          input.workflowInput,
          input.candidates,
          input.maxActions,
        );
      } finally {
        await connection.close();
      }
    },
  };
}