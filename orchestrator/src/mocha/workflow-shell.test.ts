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
    const markers: string[] = [];
    const statusUpdates: string[] = [];

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
          async upsertIssueComment(input: { marker: string; body: string }) {
            markers.push(input.marker);
            assert.match(input.body, /implement/i);
            assert.match(input.body, /invalid api credentials/i);
            assert.match(input.body, /Ready/i);
          },
          async moveProjectItemStatus(input: { statusOptionId: string }) {
            statusUpdates.push(input.statusOptionId);
          },
        },
      }),
      (error: unknown) => {
        assert.match(describeErrorCauseChain(error), /invalid api credentials/i);
        return true;
      },
    );

    assert.deepStrictEqual(markers, ['workflow:phase-failure']);
    assert.deepStrictEqual(statusUpdates, [issue.inProgressOptionId, issue.blockedOptionId]);
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

  it('returns to specify from implement_needs_input after specifyRetry without reselecting the issue', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopReadyIssueCallCount = 0;
    let getTopBacklogIssueCallCount = 0;
    let readOpenSpecChangeFilesCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-implement-to-specify-retry-test',
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() {
            getTopReadyIssueCallCount += 1;
            calls.push(`getTopReadyIssue:${getTopReadyIssueCallCount}`);
            return issue;
          },
          async getTopBacklogIssue() {
            getTopBacklogIssueCallCount += 1;
            calls.push(`getTopBacklogIssue:${getTopBacklogIssueCallCount}`);
            return issue;
          },
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktreeForIssueIfNeeded'); return worktree; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() {
            readOpenSpecChangeFilesCallCount += 1;
            calls.push(`readOpenSpecChangeFiles:${readOpenSpecChangeFilesCallCount}`);
            if (readOpenSpecChangeFilesCallCount <= 2) {
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
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
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
        await handle.signal(specifyRetrySignal);
        assert.strictEqual(await waitForBlockedReason(handle, 'awaiting_spec_review'), 'awaiting_spec_review');
        await handle.signal(specReviewedSignal);
        return handle.result();
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopReadyIssueCallCount, 1);
    assert.strictEqual(getTopBacklogIssueCallCount, 0);
    assert.strictEqual(runAgentSequenceCallCount, 3);
    assert.ok(calls.includes('writeOpenSpecChangeFiles'));
    assert.ok(calls.includes('validateOpenSpecChange'));
    assert.ok(calls.includes('createPullRequestReview'));
  });

  it('loops implement-review on needs-fix without reselecting the Ready issue', async () => {
    const calls: string[] = [];
    const statusUpdates: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopReadyIssueCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-review-needs-fix-loop-test',
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
            calls.push('readOpenSpecChangeFiles');
            return [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }];
          },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
            if (runAgentSequenceCallCount === 1 || runAgentSequenceCallCount === 3) {
              return {
                outputs: {
                  implementResponse: {
                    filesWritten: [{ path: 'src/index.ts', content: `export const attempt${runAgentSequenceCallCount} = true;\n` }],
                    commitMessage: 'feat: implement the approved spec',
                    summary: 'Implemented the approved spec bundle.',
                    followUps: [],
                  },
                },
              };
            }
            return {
              outputs: {
                reviewerResponse: runAgentSequenceCallCount === 2
                  ? { summary: 'Fix the implementation and rerun review.', findings: [{ severity: 'error', message: 'Missing validation.', location: { file: 'src/index.ts', line: 1 } }] }
                  : { summary: 'Looks ready to merge.', findings: [{ severity: 'warning', message: 'Document the helper intent.', location: { file: 'src/index.ts', line: 1 } }] },
              },
            };
          },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment(input: { marker: string }) { calls.push(`upsertIssueComment:${input.marker}`); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview(input: { event: string; body: string }) { calls.push(`createPullRequestReview:${input.event}:${/Iteration: ([0-9]+)/.exec(input.body)?.[1] ?? 'unknown'}`); },
          async upsertPullRequestReviewComment(input: { path: string; line: number }) { calls.push(`upsertPullRequestReviewComment:${input.path}:${input.line}`); },
          async moveProjectItemStatus(input: { statusOptionId: string }) {
            statusUpdates.push(input.statusOptionId);
            calls.push(`moveProjectItemStatus:${input.statusOptionId}`);
          },
        },
      },
      async (handle) => awaitResultOrTerminate(handle, 5_000),
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopReadyIssueCallCount, 1);
    assert.strictEqual(runAgentSequenceCallCount, 4);
    assert.deepStrictEqual(statusUpdates, [
      issue.inProgressOptionId,
      issue.inReviewOptionId,
      issue.readyOptionId,
      issue.inProgressOptionId,
      issue.inReviewOptionId,
      issue.readyToMergeOptionId,
    ]);
    assert.deepStrictEqual(
      calls.filter((call) => call.startsWith('createPullRequestReview:')),
      ['createPullRequestReview:REQUEST_CHANGES:1', 'createPullRequestReview:APPROVE:2'],
    );
  });

  it('ignores stale resume signals, blocks on review_escalation, then reruns implement and restarts review iteration after resume', async () => {
    const calls: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let getTopReadyIssueCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runWorkflowWithHandle<AutomateReadyIssueResult>(
      {
        workflowId: 'workflow-shell-review-escalation-resume-test',
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
            calls.push('readOpenSpecChangeFiles');
            return [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }];
          },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
            if (runAgentSequenceCallCount === 1 || runAgentSequenceCallCount === 3 || runAgentSequenceCallCount === 5 || runAgentSequenceCallCount === 7) {
              return {
                outputs: {
                  implementResponse: {
                    filesWritten: [{ path: 'src/index.ts', content: `export const pass${runAgentSequenceCallCount} = true;\n` }],
                    commitMessage: 'feat: implement the approved spec',
                    summary: 'Implemented the approved spec bundle.',
                    followUps: [],
                  },
                },
              };
            }
            if (runAgentSequenceCallCount === 2 || runAgentSequenceCallCount === 4 || runAgentSequenceCallCount === 6) {
              return {
                outputs: {
                  reviewerResponse: {
                    summary: 'Still failing review.',
                    findings: [{ severity: 'error', message: 'Still missing validation.', location: { file: 'src/index.ts', line: 1 } }],
                  },
                },
              };
            }
            return {
              outputs: {
                reviewerResponse: {
                  summary: 'Looks ready after the human escalation.',
                  findings: [{ severity: 'warning', message: 'Add one comment.', location: { file: 'src/index.ts', line: 1 } }],
                },
              },
            };
          },
          async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
          async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
          async upsertIssueComment(input: { marker: string; body: string }) { calls.push(`upsertIssueComment:${input.marker}:${/Iteration: ([0-9]+)/.exec(input.body)?.[1] ?? 'na'}`); },
          async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
          async setPullRequestReady() { calls.push('setPullRequestReady'); },
          async createPullRequestReview(input: { event: string; body: string }) { calls.push(`createPullRequestReview:${input.event}:${/Iteration: ([0-9]+)/.exec(input.body)?.[1] ?? 'unknown'}`); },
          async upsertPullRequestReviewComment(input: { path: string; line: number }) { calls.push(`upsertPullRequestReviewComment:${input.path}:${input.line}`); },
          async addIssueLabels(input: { labels: string[] }) { calls.push(`addIssueLabels:${input.labels.join(',')}`); },
          async moveProjectItemStatus(input: { statusOptionId: string }) { calls.push(`moveProjectItemStatus:${input.statusOptionId}`); },
        },
      },
      async (handle) => {
        await handle.signal(resumeSignal);
        assert.strictEqual(await waitForBlockedReason(handle, 'review_escalation'), 'review_escalation');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(await handle.query(getBlockedReasonQuery), 'review_escalation');
        assert.deepStrictEqual(
          calls.filter((call) => call.startsWith('createPullRequestReview:')),
          [
            'createPullRequestReview:REQUEST_CHANGES:1',
            'createPullRequestReview:REQUEST_CHANGES:2',
            'createPullRequestReview:COMMENT:3',
          ],
        );
        await handle.signal(resumeSignal);
        return awaitResultOrTerminate(handle, 8_000);
      },
    );

    assert.strictEqual(result.pullRequestNumber, pullRequest.pullRequestNumber);
    assert.strictEqual(getTopReadyIssueCallCount, 1);
    assert.strictEqual(runAgentSequenceCallCount, 8);
    assert.deepStrictEqual(
      calls.filter((call) => call.startsWith('createPullRequestReview:')),
      [
        'createPullRequestReview:REQUEST_CHANGES:1',
        'createPullRequestReview:REQUEST_CHANGES:2',
        'createPullRequestReview:COMMENT:3',
        'createPullRequestReview:APPROVE:1',
      ],
    );
  });

  it('upserts workflow:phase-failure and blocks the item when review throws, then ends the attempt', async () => {
    const markers: string[] = [];
    const statusUpdates: string[] = [];
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    let runAgentSequenceCallCount = 0;

    await assert.rejects(
      () => runWorkflow({
        workflowId: 'workflow-shell-review-phase-failure-comment-test',
        expectedWorkerWarnings: [/review runtime exploded/],
        workflowInput: { startPhase: 'implement' },
        activities: {
          async getTopReadyIssue() { return issue; },
          async createWorktreeForIssueIfNeeded() { return worktree; },
          async listIssueComments() { return []; },
          async readOpenSpecChangeFiles() { return [{ path: 'proposal.md', content: '# Proposal' }, { path: 'tasks.md', content: '# Tasks' }]; },
          async runAgentSequence() {
            runAgentSequenceCallCount += 1;
            if (runAgentSequenceCallCount === 1) {
              return {
                outputs: {
                  implementResponse: {
                    filesWritten: [{ path: 'src/index.ts', content: 'export const ok = true;\n' }],
                    commitMessage: 'feat: implement the approved spec',
                    summary: 'Implemented the approved spec bundle.',
                    followUps: [],
                  },
                },
              };
            }
            throw new Error('review runtime exploded');
          },
          async writeRepositoryFiles() { return undefined; },
          async runQualityGate() { return { passed: true, summary: 'make check passed', logs: '' }; },
          async commitAndPush() { return undefined; },
          async openPullRequest() { return pullRequest; },
          async upsertIssueComment(input: { marker: string; body: string }) {
            markers.push(input.marker);
            if (input.marker === 'workflow:phase-failure') {
              assert.match(input.body, /review/i);
              assert.match(input.body, /Ready/i);
              assert.match(input.body, /review runtime exploded/i);
            }
          },
          async getPullRequestDetails() { return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
          async getPullRequestDiff() { return 'diff --git a/src/index.ts b/src/index.ts'; },
          async listPullRequestFiles() { return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
          async listPullRequestReviewComments() { return []; },
          async setPullRequestReady() { return undefined; },
          async createPullRequestReview() { return undefined; },
          async upsertPullRequestReviewComment() { return undefined; },
          async moveProjectItemStatus(input: { statusOptionId: string }) { statusUpdates.push(input.statusOptionId); },
        },
      }),
      (error: unknown) => {
        assert.match(describeErrorCauseChain(error), /review runtime exploded/i);
        return true;
      },
    );

    assert.strictEqual(runAgentSequenceCallCount, 4);
    assert.deepStrictEqual(markers, ['implement:summary', 'workflow:phase-failure']);
    assert.deepStrictEqual(statusUpdates, [issue.inProgressOptionId, issue.inReviewOptionId, issue.blockedOptionId]);
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
  for (let attempt = 0; attempt < 320; attempt += 1) {
    let blockedReason: string | null;
    try {
      blockedReason = await handle.query(getBlockedReasonQuery);
    } catch (error) {
      await terminateWorkflowForTest(handle, `Query failed while waiting for blocked reason ${expectedBlockedReason}.`);
      throw new assert.AssertionError({ message: `Workflow became unavailable while waiting for ${expectedBlockedReason}: ${String(error)}` });
    }
    if (blockedReason === expectedBlockedReason) {
      return blockedReason;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await terminateWorkflowForTest(handle, `Timed out waiting for blocked reason ${expectedBlockedReason}.`);
  throw new assert.AssertionError({ message: `Timed out waiting for ${expectedBlockedReason} blocked reason.` });
}

async function awaitResultOrTerminate<T>(
  handle: Parameters<typeof runWorkflowWithHandle>[1] extends (handle: infer THandle) => Promise<unknown> ? THandle : never,
  maxMilliseconds: number,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result() as Promise<T>,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new assert.AssertionError({ message: `Timed out waiting ${maxMilliseconds}ms for workflow result.` }));
        }, maxMilliseconds);
      }),
    ]);
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      await terminateWorkflowForTest(handle, error.message);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function terminateWorkflowForTest(
  handle: Parameters<typeof runWorkflowWithHandle>[1] extends (handle: infer THandle) => Promise<unknown> ? THandle : never,
  reason: string,
): Promise<void> {
  try {
    await handle.terminate(reason);
  } catch {
    // Ignore termination failures in tests; the original assertion/error should win.
  }
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