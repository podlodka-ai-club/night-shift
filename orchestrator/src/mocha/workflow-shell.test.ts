import assert from 'assert';
import { describe, it } from 'mocha';
import type { AutomateReadyIssueResult } from '../shared';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { createWorkflowTestRig } from './workflow-test-helpers';
import {
  activityProgressSignal,
  getBlockedReasonQuery,
  implementRetrySignal,
  renderWorkflowCurrentDetails,
  resumeSignal,
  specifyRetrySignal,
  specReviewedSignal,
} from '../workflows';

const { runWorkflow, runWorkflowWithHandle } = createWorkflowTestRig();

describe('workflow phased shell', function () {
  this.timeout(60_000);

  it('supports implement-start through the phased shell', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-implement-start-test',
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() { calls.push('getTopReadyIssue'); return issue; },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() {
            calls.push('readOpenSpecChangeFiles');
            return [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '# Tasks' },
            ];
          },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
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
              threadId: 'review-thread-123',
              completedStepIds: ['review'],
              outputs: {
                reviewerResponse: {
                  summary: 'Looks ready to merge.',
                  findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }],
                },
              },
              finalResponse: JSON.stringify({ reviewed: true }),
            };
          },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview() { calls.push('createPullRequestReview'); },
          async upsertPullRequestReviewComment() { calls.push('upsertPullRequestReviewComment'); },
          async moveProjectItemStatus() { calls.push('moveProjectItemStatus'); },
        },
      },
      async (handle) => handle.result(),
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.deepStrictEqual(calls, [
      'getTopReadyIssue',
      'createWorktreeForIssueIfNeeded',
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'moveProjectItemStatus',
      'runAgentSequence:1',
      'writeRepositoryFiles',
      'runQualityGate',
      'commitAndPush',
      'openPullRequest',
      'upsertIssueComment',
      'moveProjectItemStatus',
      'getPullRequestDetails',
      'readOpenSpecChangeFiles',
      'getPullRequestDiff',
      'listPullRequestFiles',
      'listPullRequestReviewComments',
      'runAgentSequence:2',
      'createPullRequestReview',
      'upsertPullRequestReviewComment',
      'upsertIssueComment',
      'moveProjectItemStatus',
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
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() {
            calls.push('readOpenSpecChangeFiles');
            return runAgentSequenceCallCount >= 1
              ? [
                  { path: 'proposal.md', content: '# Proposal' },
                  { path: 'tasks.md', content: '# Tasks' },
                ]
              : [];
          },
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

            if (runAgentSequenceCallCount === 2) {
              return {
                threadId: 'implement-thread-123',
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
              threadId: 'review-thread-123',
              completedStepIds: ['review'],
              outputs: {
                reviewerResponse: {
                  summary: 'Looks ready to merge.',
                  findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }],
                },
              } as any,
              finalResponse: JSON.stringify({ reviewed: true }),
            };
          },
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview() { calls.push('createPullRequestReview'); },
          async upsertPullRequestReviewComment() { calls.push('upsertPullRequestReviewComment'); },
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
    assert.strictEqual(runAgentSequenceCallCount, 3);
    assert.ok(calls.includes('getTopBacklogIssue'));
    assert.ok(calls.includes('writeOpenSpecChangeFiles'));
    assert.ok(calls.includes('validateOpenSpecChange'));
    assert.ok(calls.includes('upsertIssueComment'));
    assert.ok(calls.includes('writeRepositoryFiles'));
    assert.ok(calls.includes('runQualityGate'));
    assert.ok(calls.includes('createPullRequestReview'));
    assert.ok(!calls.includes('getTopReadyIssue'));
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
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() {
            calls.push('readOpenSpecChangeFiles');
            return runAgentSequenceCallCount >= 2
              ? [
                  { path: 'proposal.md', content: '# Proposal' },
                  { path: 'tasks.md', content: '# Tasks' },
                ]
              : [];
          },
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

            if (runAgentSequenceCallCount === 3) {
              return {
                threadId: 'implement-thread-123',
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
              threadId: 'review-thread-123',
              completedStepIds: ['review'],
              outputs: {
                reviewerResponse: {
                  summary: 'Looks ready to merge.',
                  findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }],
                },
              } as any,
              finalResponse: JSON.stringify({ reviewed: true }),
            };
          },
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview() { calls.push('createPullRequestReview'); },
          async upsertPullRequestReviewComment() { calls.push('upsertPullRequestReviewComment'); },
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
    assert.strictEqual(runAgentSequenceCallCount, 4);
    assert.strictEqual(calls.filter((call) => call === 'getTopBacklogIssue').length, 1);
    assert.strictEqual(calls.filter((call) => call === 'upsertIssueComment').length, 4);
    assert.ok(calls.includes('writeRepositoryFiles'));
    assert.ok(calls.includes('runQualityGate'));
    assert.ok(calls.includes('createPullRequestReview'));
    assert.ok(!calls.includes('getTopReadyIssue'));
  });

  it('rethrows runtime implement errors without opening a pull request', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);

    await runWorkflowWithHandle<void>(
      {
        workflowId: 'workflow-shell-implement-runtime-failure-test',
        workflowInput: { startPhase: 'implement' },
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
          async writeRepositoryFiles() { return undefined; },
          async runQualityGate() { return { passed: true, summary: 'ok', logs: '' }; },
          async commitAndPush() { return undefined; },
          async openPullRequest() { throw new Error('should not open pull request'); },
          async upsertIssueComment() { return undefined; },
          async moveProjectItemStatus() { return undefined; },
        },
      },
      async (handle) => {
        await assert.rejects(handle.result(), /Workflow execution failed/);
      },
    );
  });

  it('rethrows runtime implement errors whose message contains invalid without misclassifying them as needs_input', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);

    await assert.rejects(
      () => runWorkflow({
        workflowId: 'workflow-shell-implement-invalid-runtime-failure-test',
        workflowInput: { startPhase: 'implement' },
        expectedWorkerWarnings: [/invalid api credentials/],
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
          async runAgentSequence() { throw new Error('invalid api credentials'); },
          async writeRepositoryFiles() { throw new Error('should not write files'); },
          async runQualityGate() { throw new Error('should not run gate'); },
          async commitAndPush() { throw new Error('should not commit'); },
          async openPullRequest() { throw new Error('should not open pull request'); },
          async upsertIssueComment() { throw new Error('should not comment'); },
          async moveProjectItemStatus() { return undefined; },
        },
      }),
      (error: unknown) => {
        assert.match(describeErrorCauseChain(error), /invalid api credentials/i);
        return true;
      },
    );
  });

  it('blocks on implement_needs_input and reruns implement after implementRetry without reselecting the issue', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopReadyIssueCallCount = 0;
    let readOpenSpecChangeFilesCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-implement-retry-test',
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() {
            getTopReadyIssueCallCount += 1;
            calls.push(`getTopReadyIssue:${getTopReadyIssueCallCount}`);
            return issue;
          },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() {
            readOpenSpecChangeFilesCallCount += 1;
            calls.push(`readOpenSpecChangeFiles:${readOpenSpecChangeFilesCallCount}`);
            if (readOpenSpecChangeFilesCallCount === 1) {
              return [];
            }
            return [
              { path: 'proposal.md', content: '# Proposal' },
              { path: 'tasks.md', content: '# Tasks' },
            ];
          },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
            if (runAgentSequenceCallCount === 1) {
              return {
                threadId: 'implement-thread-123',
                completedStepIds: ['implement'],
                outputs: {
                  implementResponse: {
                    filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }],
                    commitMessage: 'feat: implement the approved spec',
                    summary: 'Implements the approved spec bundle.',
                    followUps: [],
                  },
                } as any,
                finalResponse: JSON.stringify({ implemented: true }),
              };
            }
            return {
              threadId: 'review-thread-123',
              completedStepIds: ['review'],
              outputs: {
                reviewerResponse: {
                  summary: 'Looks ready to merge.',
                  findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }],
                },
              } as any,
              finalResponse: JSON.stringify({ reviewed: true }),
            };
          },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'ok', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview() { calls.push('createPullRequestReview'); },
          async upsertPullRequestReviewComment() { calls.push('upsertPullRequestReviewComment'); },
          async moveProjectItemStatus() { calls.push('moveProjectItemStatus'); },
        },
      },
      async (handle) => {
        assert.strictEqual(await waitForBlockedReason(handle, 'implement_needs_input'), 'implement_needs_input');
        await handle.signal(resumeSignal);
        assert.strictEqual(await handle.query(getBlockedReasonQuery), 'implement_needs_input');
        await handle.signal(implementRetrySignal);
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopReadyIssueCallCount, 1);
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.ok(calls.includes('upsertIssueComment'));
    assert.ok(calls.includes('openPullRequest'));
    assert.ok(calls.includes('createPullRequestReview'));
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

function describeErrorCauseChain(error: unknown): string {
  const visited = new Set<unknown>();
  const parts: string[] = [];
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      parts.push(candidate.message);
    }
    current = candidate.cause;
  }

  return parts.join('\n');
}