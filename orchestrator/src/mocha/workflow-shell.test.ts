import assert from 'assert';
import { describe, it } from 'mocha';
import type { AutomateReadyIssueResult } from '../shared';
import { buildGeneratedChangeMetadata, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { buildExpectedCreatedPullRequest } from './activity-test-helpers';
import { createWorkflowTestRig } from './workflow-test-helpers';
import {
  activityProgressSignal,
  getBlockedReasonQuery,
  renderWorkflowCurrentDetails,
  resumeSignal,
  specifyRetrySignal,
  specReviewedSignal,
} from '../workflows';

const { runWorkflowWithHandle } = createWorkflowTestRig();

describe('workflow phased shell', function () {
  this.timeout(60_000);

  it('supports implement-start through the phased shell', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-implement-start-test',
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async runAgentSequence() {
            calls.push('runAgentSequence');
            return {
              threadId: 'thread-123',
              completedStepIds: ['edit', 'change-metadata'],
              outputs: { changeMetadata: buildGeneratedChangeMetadata() },
              finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
            };
          },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async cleanupWorktree() { calls.push('cleanupWorktree'); },
          async commentOnIssue() { calls.push('commentOnIssue'); },
          async moveProjectItemStatus() { calls.push('moveProjectItemStatus'); },
        },
      },
      async (handle) => handle.result(),
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'moveProjectItemStatus',
      'createWorktreeForIssueIfNeeded',
      'runAgentSequence',
      'commitAndPush',
      'openPullRequest',
      'commentOnIssue',
      'moveProjectItemStatus',
      'cleanupWorktree',
    ]);
  });

  it('runs a refined specify pass, blocks on spec review, then continues into implement after approval', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-specify-refined-test',
        workflowInput: { startPhase: 'specify' },
        activities: {
          async getTopBacklogIssue() { calls.push('getTopBacklogIssue'); return issue; },
          async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
            if (runAgentSequenceCallCount === 1) {
              return {
                threadId: 'specify-thread-123',
                completedStepIds: ['specify'],
                outputs: {
                  specifyResponse: {
                    files: [
                      { path: 'proposal.md', content: '# Proposal' },
                      { path: 'tasks.md', content: '# Tasks' },
                    ],
                    openQuestions: [],
                    assumptions: [],
                    risks: [],
                  },
                } as any,
                finalResponse: JSON.stringify({ refined: true }),
              };
            }

            return {
              threadId: 'implement-thread-123',
              completedStepIds: ['edit', 'change-metadata'],
              outputs: { changeMetadata: buildGeneratedChangeMetadata() },
              finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
            };
          },
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async cleanupWorktree() { calls.push('cleanupWorktree'); },
          async commentOnIssue() { calls.push('commentOnIssue'); },
          async moveProjectItemStatus() { calls.push('moveProjectItemStatus'); },
        },
      },
      async (handle) => {
        assert.strictEqual(await waitForBlockedReason(handle, 'awaiting_spec_review'), 'awaiting_spec_review');
        await handle.signal(activityProgressSignal, 'Waiting for operator review');
        await handle.signal(resumeSignal);
        assert.strictEqual(await handle.query(getBlockedReasonQuery), 'awaiting_spec_review');
        await handle.signal(specReviewedSignal);
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.ok(calls.includes('getTopBacklogIssue'));
    assert.ok(calls.includes('writeOpenSpecChangeFiles'));
    assert.ok(calls.includes('validateOpenSpecChange'));
    assert.ok(calls.includes('upsertIssueComment'));
    assert.ok(calls.includes('getTopReadyIssue'));
    assert.ok(calls.includes('commentOnIssue'));
    assert.ok(calls.indexOf('upsertIssueComment') < calls.indexOf('getTopReadyIssue'));
  });

  it('blocks on specify_needs_input for open questions and reruns specify after specifyRetry', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-specify-needs-input-test',
        workflowInput: { startPhase: 'specify' },
        activities: {
          async getTopBacklogIssue() { calls.push('getTopBacklogIssue'); return issue; },
          async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
            if (runAgentSequenceCallCount === 1) {
              return {
                threadId: `specify-thread-${runAgentSequenceCallCount}`,
                completedStepIds: ['specify'],
                outputs: {
                  specifyResponse: {
                    files: [
                      { path: 'proposal.md', content: '# Proposal' },
                      { path: 'tasks.md', content: '# Tasks' },
                    ],
                    openQuestions: ['What API shape should this use?'],
                    assumptions: [],
                    risks: [],
                  },
                } as any,
                finalResponse: JSON.stringify({ needsInput: true }),
              };
            }

            if (runAgentSequenceCallCount === 2) {
              return {
                threadId: 'specify-thread-2',
                completedStepIds: ['specify'],
                outputs: {
                  specifyResponse: {
                    files: [
                      { path: 'proposal.md', content: '# Proposal' },
                      { path: 'tasks.md', content: '# Tasks' },
                    ],
                    openQuestions: [],
                    assumptions: [],
                    risks: [],
                  },
                } as any,
                finalResponse: JSON.stringify({ refined: true }),
              };
            }

            return {
              threadId: 'implement-thread-123',
              completedStepIds: ['edit', 'change-metadata'],
              outputs: { changeMetadata: buildGeneratedChangeMetadata() },
              finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
            };
          },
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async cleanupWorktree() { calls.push('cleanupWorktree'); },
          async commentOnIssue() { calls.push('commentOnIssue'); },
          async moveProjectItemStatus() { calls.push('moveProjectItemStatus'); },
        },
      },
      async (handle) => {
        assert.strictEqual(await waitForBlockedReason(handle, 'specify_needs_input'), 'specify_needs_input');
        await handle.signal(resumeSignal);
        assert.strictEqual(await handle.query(getBlockedReasonQuery), 'specify_needs_input');
        await handle.signal(specifyRetrySignal);
        assert.strictEqual(await waitForBlockedReason(handle, 'awaiting_spec_review'), 'awaiting_spec_review');
        await handle.signal(specReviewedSignal);
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(runAgentSequenceCallCount, 3);
    assert.strictEqual(calls.filter((call) => call === 'getTopBacklogIssue').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment').length, 2);
    assert.ok(calls.includes('getTopReadyIssue'));
    assert.ok(calls.includes('commentOnIssue'));
  });

  it('surfaces implement-phase failure state before rethrowing the activity error', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const failureGate = createDeferred<void>();
    let statusUpdateCallCount = 0;

    await runWorkflowWithHandle<void>(
      {
        workflowId: 'workflow-shell-implement-failure-state-test',
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() { return issue; },
          async createWorktreeForIssueIfNeeded() { return worktree; },
          async runAgentSequence() { throw new Error('agent failed'); },
          async commitAndPush() { return undefined; },
          async openPullRequest() { throw new Error('should not open pull request'); },
          async cleanupWorktree() { return undefined; },
          async commentOnIssue() { return undefined; },
          async moveProjectItemStatus() {
            statusUpdateCallCount += 1;
            if (statusUpdateCallCount === 2) {
              await failureGate.promise;
            }
          },
        },
      },
      async (handle) => {
        assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
        failureGate.resolve();
        await assert.rejects(handle.result(), /Workflow execution failed/);
      },
    );
  });

  it('renders current details with phase, blocked reason, and recent activity', () => {
    const rendered = renderWorkflowCurrentDetails({
      startPhase: 'implement',
      currentPhase: 'specify',
      blockedReason: 'awaiting_spec_review',
      reviewIteration: 0,
      maxReviewIterations: 3,
      latestActivity: 'Waiting for operator review',
      issueNumber: 7,
      issueTitle: 'Demo issue',
    });

    assert.match(rendered, /Current phase: specify/i);
    assert.match(rendered, /Blocked reason: awaiting_spec_review/i);
    assert.match(rendered, /Latest activity: Waiting for operator review/i);
  });
});

async function waitForBlockedReason(
  handle: Parameters<typeof runWorkflowWithHandle>[1] extends (handle: infer T) => Promise<unknown> ? T : never,
  expectedBlockedReason: string,
): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const blockedReason = await handle.query(getBlockedReasonQuery);
    if (blockedReason === expectedBlockedReason) {
      return blockedReason;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new assert.AssertionError({ message: `Timed out waiting for ${expectedBlockedReason} blocked reason.` });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}