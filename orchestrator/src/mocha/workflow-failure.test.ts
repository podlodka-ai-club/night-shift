import { describe, it } from 'mocha';
import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MoveProjectItemStatusInput } from '../shared';
import { getBlockedReasonQuery } from '../workflows';
import { loadWorkerEntrypointConfig } from '../entrypoint-config';
import {
  buildSelectedIssue,
  buildWorktreeContext,
} from './activity-test-helpers';
import {
  assertWorkflowActivityFailure,
  buildStatusUpdateInput,
  createWorkflowTestRig,
} from './workflow-test-helpers';

const { runWorkflow, runWorkflowWithHandle } = createWorkflowTestRig();

describe('workflow failure paths', function () {
  this.timeout(60_000);

  it('hands project extension manifest load failures to escalation and blocks for human retry', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    const markers: string[] = [];
    const commentBodies = new Map<string, string>();

    await runWorkflowWithHandle(
      {
        workflowId: 'automate-ready-issue-project-extension-failure-test',
        expectedWorkerWarnings: [/invalid project extension/],
        activities: {
          async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
          async loadProjectExtensionManifest() { calls.push('loadProjectExtensionManifest:7'); throw new Error('invalid project extension'); },
          async listIssueComments() { calls.push('listIssueComments:7'); return []; },
          async readOpenSpecChangeFiles() {
            calls.push('readOpenSpecChangeFiles:7');
            return [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '# Tasks' },
            ];
          },
          async runAgentSequence() {
            calls.push('runAgentSequence:7');
            return {
              outputs: {
                escalationResponse: {
                  outcome: 'needs_human',
                  originPhase: 'implement',
                  confidence: 'low',
                  rootCause: {
                    category: 'infrastructure_failure',
                    summary: 'The project extension manifest could not be loaded.',
                    evidence: ['invalid project extension'],
                  },
                  resolution: {
                    summary: 'A human needs to fix the project extension before Implement can continue.',
                    files: [],
                    validationPlan: [],
                    resumeStatus: 'Ready',
                  },
                  humanRequest: {
                    question: 'Fix the project extension, then move the issue back to Ready.',
                    recommendedStatusAfterAnswer: 'Ready',
                  },
                  issueComment: 'Escalation Manager could not recover the project extension manifest failure automatically.',
                },
              } as any,
            };
          },
          async writeRepositoryFiles() { throw new Error('writeRepositoryFiles should not run after extension load failure'); },
          async runQualityGate() { throw new Error('runQualityGate should not run after extension load failure'); },
          async commitAndPush() { throw new Error('commitAndPush should not run after extension load failure'); },
          async openPullRequest() { throw new Error('openPullRequest should not run after extension load failure'); },
          async upsertIssueComment(input: { marker: string; body: string }) {
            markers.push(input.marker);
            commentBodies.set(input.marker, input.body);
            calls.push(`upsertIssueComment:${input.marker}`);
          },
          async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
            statusUpdates.push(input);
            calls.push(`moveProjectItemStatus:${input.projectItemId}`);
          },
        },
      },
      async (handle) => {
        assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
        await handle.terminate('done');
      },
    );

    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'createWorktreeForIssueIfNeeded:7',
      'loadProjectExtensionManifest:7',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'runAgentSequence:7',
      'upsertIssueComment:escalation:human-needed',
      'moveProjectItemStatus:item-1',
      'upsertIssueComment:workflow:phase-failure',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
    assert.deepStrictEqual(markers, ['escalation:human-needed', 'workflow:phase-failure']);
    assert.match(commentBodies.get('escalation:human-needed') ?? '', /project extension/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /invalid project extension/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /Ready/i);
  });

  it('blocks through escalation after exhausted agent failures move the issue to In progress', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const markers: string[] = [];
    const commentBodies = new Map<string, string>();
    let cleanupCalls = 0;

    await runWorkflowWithHandle(
      {
          workflowId: 'automate-ready-issue-failure-test',
          expectedWorkerWarnings: [/agent failed/],
          activities: {
            async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
            async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded:7'); return worktree; },
            async listIssueComments() { calls.push('listIssueComments:7'); return []; },
            async readOpenSpecChangeFiles() {
              calls.push('readOpenSpecChangeFiles:7');
              return [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '# Tasks' },
              ];
            },
            async runAgentSequence() { calls.push('runAgentSequence:7'); throw new Error('agent failed'); },
            async writeRepositoryFiles() { throw new Error('writeRepositoryFiles should not run after agent failure'); },
            async runQualityGate() { throw new Error('runQualityGate should not run after agent failure'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async upsertIssueComment(input: { marker: string; body: string }) {
              markers.push(input.marker);
              commentBodies.set(input.marker, input.body);
              calls.push(`upsertIssueComment:${input.marker}`);
            },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
              calls.push(`moveProjectItemStatus:${input.projectItemId}`);
            },
            async cleanupWorktree() {
              cleanupCalls += 1;
            },
          },
        },
        async (handle) => {
          assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
          await handle.terminate('done');
        },
    );

    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'moveProjectItemStatus:item-1',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'moveProjectItemStatus:item-1',
      'createWorktreeForIssueIfNeeded:7',
      'listIssueComments:7',
      'readOpenSpecChangeFiles:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'runAgentSequence:7',
      'upsertIssueComment:escalation:human-needed',
      'moveProjectItemStatus:item-1',
      'upsertIssueComment:workflow:phase-failure',
    ]);
    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
    assert.deepStrictEqual(markers, ['escalation:human-needed', 'workflow:phase-failure']);
    assert.match(commentBodies.get('escalation:human-needed') ?? '', /implement/i);
    assert.match(commentBodies.get('escalation:human-needed') ?? '', /agent failed/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /agent failed/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /Ready/i);
    assert.strictEqual(cleanupCalls, 0);
  });

  it('blocks through escalation when commitAndPush fails after the gate passes', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];
    const markers: string[] = [];
    const commentBodies = new Map<string, string>();
    let runAgentSequenceCallCount = 0;

    await runWorkflowWithHandle(
      {
          workflowId: 'automate-ready-issue-commit-failure-test',
          expectedWorkerWarnings: [/commit failed/],
          activities: {
            async getTopReadyIssue() { return issue; },
            async createWorktreeForIssueIfNeeded() { return worktree; },
            async listIssueComments() { return []; },
            async readOpenSpecChangeFiles() {
              return [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '# Tasks' },
              ];
            },
            async runAgentSequence() {
              runAgentSequenceCallCount += 1;
              if (runAgentSequenceCallCount === 1) {
                return {
                  threadId: 'thread-123',
                  completedStepIds: ['implement'],
                  outputs: {
                    implementResponse: {
                      filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }],
                      commitMessage: 'feat: implement the approved spec',
                      summary: 'Implements the approved spec bundle.',
                      followUps: [],
                    },
                  },
                  finalResponse: JSON.stringify({ implemented: true }),
                };
              }

              return {
                outputs: {
                  escalationResponse: {
                    outcome: 'needs_human',
                    originPhase: 'implement',
                    confidence: 'low',
                    rootCause: {
                      category: 'infrastructure_failure',
                      summary: 'commit failed after the quality gate passed.',
                      evidence: ['commit failed'],
                    },
                    resolution: {
                      summary: 'A human needs to inspect the failed commit before Implement can continue.',
                      files: [],
                      validationPlan: [],
                      resumeStatus: 'Ready',
                    },
                    humanRequest: {
                      question: 'Fix the commit failure, then move the issue back to Ready.',
                      recommendedStatusAfterAnswer: 'Ready',
                    },
                    issueComment: 'Escalation Manager could not recover the failed commit automatically.',
                  },
                } as any,
              };
            },
            async writeRepositoryFiles() { return undefined; },
            async runQualityGate() { return { passed: true, summary: 'ok', logs: '' }; },
            async commitAndPush() { throw new Error('commit failed'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after commit failure'); },
            async upsertIssueComment(input: { marker: string; body: string }) {
              markers.push(input.marker);
              commentBodies.set(input.marker, input.body);
            },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
            },
          },
        },
        async (handle) => {
          assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
          await handle.terminate('done');
        },
    );

    assert.deepStrictEqual(statusUpdates, [
      buildStatusUpdateInput(issue, issue.inProgressOptionId),
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
    assert.deepStrictEqual(markers, ['escalation:human-needed', 'workflow:phase-failure']);
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.match(commentBodies.get('escalation:human-needed') ?? '', /commit failed/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /commit failed/i);
    assert.match(commentBodies.get('workflow:phase-failure') ?? '', /Ready/i);
  });

  it('preserves the original phase failure when blocked cleanup also throws', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const statusUpdates: MoveProjectItemStatusInput[] = [];

    await assert.rejects(
      () =>
        runWorkflow({
          workflowId: 'automate-ready-issue-cleanup-failure-test',
          expectedWorkerWarnings: [/agent failed/],
          activities: {
            async getTopReadyIssue() { return issue; },
            async createWorktreeForIssueIfNeeded() { return worktree; },
            async listIssueComments() { return []; },
            async readOpenSpecChangeFiles() {
              return [
                { path: 'proposal.md', content: '# Proposal' },
                { path: 'tasks.md', content: '# Tasks' },
              ];
            },
            async runAgentSequence() { throw new Error('agent failed'); },
            async writeRepositoryFiles() { throw new Error('writeRepositoryFiles should not run after agent failure'); },
            async runQualityGate() { throw new Error('runQualityGate should not run after agent failure'); },
            async commitAndPush() { throw new Error('commit should not run after agent failure'); },
            async openPullRequest() { throw new Error('openPullRequest should not run after agent failure'); },
            async upsertIssueComment() { throw new Error('upsertIssueComment should not run when blocked cleanup fails first'); },
            async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
              statusUpdates.push(input);
              if (statusUpdates.length > 1) throw new Error('cleanup status update failed');
            },
          },
        }),
      (error: unknown) => assertWorkflowActivityFailure(error, /agent failed/),
    );

    assert.deepStrictEqual(statusUpdates[0], buildStatusUpdateInput(issue, issue.inProgressOptionId));
    assert.deepStrictEqual(statusUpdates.slice(1), [
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.escalatedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
      buildStatusUpdateInput(issue, issue.blockedOptionId),
    ]);
  });

  it('threads entrypoint and project agent selections into specify before surfacing a phase failure', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-workflow-agents-failure-'));
    try {
      await writeFile(
        path.join(tempDir, 'orchestrator.config.ts'),
        [
          'export default {',
          "  agents: { default: { config: { reasoningEffort: 'high' } }, specify: { config: { model: 'claude-haiku-4-5', temperature: 0.2 } } },",
          "  targets: [{ id: 'orchestrator-testing', project: { owner: 'Mugenor', number: 1 }, repo: { owner: 'Mugenor', name: 'orchestrator-testing' } }],",
          '};',
        ].join('\n'),
        'utf8',
      );
      const { workflowInput } = await loadWorkerEntrypointConfig({ cwd: tempDir, env: {} });
      const issue = buildSelectedIssue();
      const worktree = buildWorktreeContext(issue);
      const statusUpdates: MoveProjectItemStatusInput[] = [];
      const runAgentSelections: unknown[] = [];

      await runWorkflowWithHandle(
        {
            workflowId: 'automate-ready-issue-specify-agent-failure-test',
            workflowInput: { ...workflowInput, startPhase: 'specify' },
            expectedWorkerWarnings: [/specify agent failed/],
            activities: {
              async getTopBacklogIssue() { return issue; },
              async createWorktreeForIssueIfNeeded() { return worktree; },
              async loadProjectExtensionManifest() {
                return {
                  prompts: {
                    specify: { prepend: [], append: [] },
                    implement: { prepend: [], append: [] },
                    review: { prepend: [], append: [] },
                  },
                  agentDefaults: { config: { maxTurns: 5 } },
                  agents: {
                    specify: { config: { model: 'claude-sonnet-4-6', temperature: 0.1 } },
                  },
                  qualityGates: [],
                };
              },
              async listIssueComments() { return []; },
              async readOpenSpecChangeFiles() { return []; },
              async writeOpenSpecChangeFiles() { throw new Error('writeOpenSpecChangeFiles should not run after the agent failure'); },
              async validateOpenSpecChange() { throw new Error('validateOpenSpecChange should not run after the agent failure'); },
              async runAgentSequence(input: { providerSelection?: unknown }) {
                if (input.providerSelection !== undefined) {
                  runAgentSelections.push(input.providerSelection);
                }
                throw new Error('specify agent failed');
              },
              async commitAndPush() { throw new Error('commitAndPush should not run after the agent failure'); },
              async openPullRequest() { throw new Error('openPullRequest should not run after the agent failure'); },
              async upsertIssueComment() { return undefined; },
              async moveProjectItemStatus(input: MoveProjectItemStatusInput) {
                statusUpdates.push(input);
              },
            },
          },
        async (handle) => {
          assert.strictEqual(await waitForBlockedReason(handle, 'specify_needs_input'), 'specify_needs_input');
          await handle.terminate('done');
        },
      );

      assert.deepStrictEqual(runAgentSelections, [
        {
          config: {
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
            temperature: 0.1,
            maxTurns: 5,
          },
        },
        {
          config: {
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
            temperature: 0.1,
            maxTurns: 5,
          },
        },
        {
          config: {
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
            temperature: 0.1,
            maxTurns: 5,
          },
        },
      ]);
      assert.deepStrictEqual(statusUpdates, [
        buildStatusUpdateInput(issue, issue.refinementOptionId),
        buildStatusUpdateInput(issue, issue.escalatedOptionId),
        buildStatusUpdateInput(issue, issue.blockedOptionId),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForBlockedReason(
  handle: { query: (queryDef: typeof getBlockedReasonQuery) => Promise<string | null> },
  expectedBlockedReason: string,
): Promise<string> {
  for (let attempt = 0; attempt < 320; attempt += 1) {
    const blockedReason = await handle.query(getBlockedReasonQuery);
    if (blockedReason === expectedBlockedReason) {
      return blockedReason;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new assert.AssertionError({ message: `Timed out waiting for ${expectedBlockedReason} blocked reason.` });
}
