import assert from 'assert';
import { describe, it } from 'mocha';
import { ESCALATION_RESPONSE_OUTPUT_KEY } from '../shared';
import { runEscalationPhase } from '../phases/escalation/phase';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';

describe('escalation phase', () => {
  it('resolves an implement escalation with file changes, validates, updates PR context, and returns to Ready', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];

    const result = await runEscalationPhase(
      {
        issue,
        originPhase: 'implement',
        blockedReason: 'implement_needs_input',
        worktree,
        pullRequest,
      },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return [{ path: 'proposal.md', content: '# Proposal' }]; },
        async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
        async getPullRequestDiff() { calls.push('getPullRequestDiff'); return 'diff --git a/src/index.ts b/src/index.ts'; },
        async listPullRequestFiles() { calls.push('listPullRequestFiles'); return [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]; },
        async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
        async runAgentSequence() {
          calls.push('runAgentSequence');
          return {
            outputs: {
              [ESCALATION_RESPONSE_OUTPUT_KEY]: {
                outcome: 'resolved',
                originPhase: 'implement',
                confidence: 'high',
                rootCause: {
                  category: 'quality_gate_failure',
                  summary: 'The helper was never exported.',
                  evidence: ['make check failed'],
                },
                resolution: {
                  summary: 'Export the helper and rerun the gate.',
                  files: [{ path: 'src/index.ts', content: 'export * from "./runtime";\n' }],
                  commitMessage: 'fix: export runtime helper',
                  validationPlan: ['Run make check'],
                  resumeStatus: 'Ready',
                },
                issueComment: 'Escalation Manager exported the helper.',
              },
            },
          };
        },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); assert.match(input.body, /Resume status: Ready/); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'resolved');
    assert.strictEqual(result.resumeStatus, 'Ready');
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'getPullRequestDetails',
      'getPullRequestDiff',
      'listPullRequestFiles',
      'listPullRequestReviewComments',
      'runAgentSequence',
      'writeRepositoryFiles',
      'runQualityGate',
      'commitAndPush',
      'openPullRequest',
      'upsertIssueComment:escalation:summary',
      `move:${issue.readyOptionId}`,
    ]);
  });

  it('resolves a review-only escalation with no file changes and returns to In review without commit/push', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];

    const result = await runEscalationPhase(
      {
        issue,
        originPhase: 'review',
        blockedReason: 'review_escalation',
        worktree,
        pullRequest,
      },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: pullRequest.pullRequestNumber, pullRequestUrl: pullRequest.pullRequestUrl, headSha: 'abc123', isDraft: false }; },
        async getPullRequestDiff() { calls.push('getPullRequestDiff'); return ''; },
        async listPullRequestFiles() { calls.push('listPullRequestFiles'); return []; },
        async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
        async runAgentSequence() {
          calls.push('runAgentSequence');
          return {
            outputs: {
              [ESCALATION_RESPONSE_OUTPUT_KEY]: {
                outcome: 'resolved',
                originPhase: 'review',
                confidence: 'medium',
                rootCause: {
                  category: 'review_findings',
                  summary: 'The stale review comment no longer matches the diff.',
                  evidence: ['The offending hunk is gone.'],
                },
                resolution: {
                  summary: 'Refresh review context and rerun Review.',
                  files: [],
                  validationPlan: ['Refresh PR metadata'],
                  resumeStatus: 'In review',
                },
                issueComment: 'Escalation Manager determined this is a review-only recovery.',
              },
            },
          };
        },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'make check passed', logs: '' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); assert.match(input.body, /Pull request:/); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'resolved');
    assert.strictEqual(result.resumeStatus, 'In review');
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'getPullRequestDetails',
      'getPullRequestDiff',
      'listPullRequestFiles',
      'listPullRequestReviewComments',
      'runAgentSequence',
      'upsertIssueComment:escalation:summary',
      `move:${issue.inReviewOptionId}`,
    ]);
  });

  it('retries once after validation failure and succeeds on the repaired response', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];
    let runAgentSequenceCallCount = 0;
    let qualityGateCallCount = 0;

    const result = await runEscalationPhase(
      {
        issue,
        originPhase: 'implement',
        blockedReason: 'implement_needs_input',
        worktree,
      },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async getPullRequestDetails() { calls.push('getPullRequestDetails'); return { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42', headSha: 'abc123', isDraft: false }; },
        async getPullRequestDiff() { calls.push('getPullRequestDiff'); return ''; },
        async listPullRequestFiles() { calls.push('listPullRequestFiles'); return []; },
        async listPullRequestReviewComments() { calls.push('listPullRequestReviewComments'); return []; },
        async runAgentSequence() {
          runAgentSequenceCallCount += 1;
          calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
          return {
            outputs: {
              [ESCALATION_RESPONSE_OUTPUT_KEY]: {
                outcome: 'resolved',
                originPhase: 'implement',
                confidence: 'high',
                rootCause: {
                  category: 'quality_gate_failure',
                  summary: 'The helper was never exported.',
                  evidence: ['make check failed'],
                },
                resolution: {
                  summary: runAgentSequenceCallCount === 1 ? 'First attempt.' : 'Second attempt.',
                  files: [{ path: 'src/index.ts', content: `export const attempt = ${runAgentSequenceCallCount};\n` }],
                  commitMessage: 'fix: export helper',
                  validationPlan: ['Run make check'],
                  resumeStatus: 'Ready',
                },
                issueComment: 'Escalation Manager repaired the issue.',
              },
            },
          };
        },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() {
          qualityGateCallCount += 1;
          calls.push(`runQualityGate:${qualityGateCallCount}`);
          return qualityGateCallCount === 1
            ? { passed: false, summary: 'make check failed', logs: 'src/index.ts missing export' }
            : { passed: true, summary: 'make check passed', logs: '' };
        },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return { branchName: worktree.branchName, pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42' }; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'resolved');
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.strictEqual(qualityGateCallCount, 2);
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence:1',
      'writeRepositoryFiles',
      'runQualityGate:1',
      'runAgentSequence:2',
      'writeRepositoryFiles',
      'runQualityGate:2',
      'commitAndPush',
      'openPullRequest',
      'upsertIssueComment:escalation:summary',
      `move:${issue.readyOptionId}`,
    ]);
  });

  it('falls back to human-needed when validation is still failing after one repair attempt', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];

    const result = await runEscalationPhase(
      {
        issue,
        originPhase: 'implement',
        worktree,
      },
      {
        async createWorktreeForIssueIfNeeded() { return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async getPullRequestDetails() { throw new Error('should not request PR'); },
        async getPullRequestDiff() { throw new Error('should not request diff'); },
        async listPullRequestFiles() { throw new Error('should not request files'); },
        async listPullRequestReviewComments() { throw new Error('should not request review comments'); },
        async runAgentSequence() {
          calls.push('runAgentSequence');
          return {
            outputs: {
              [ESCALATION_RESPONSE_OUTPUT_KEY]: {
                outcome: 'resolved',
                originPhase: 'implement',
                confidence: 'high',
                rootCause: {
                  category: 'quality_gate_failure',
                  summary: 'The helper was never exported.',
                  evidence: ['make check failed'],
                },
                resolution: {
                  summary: 'Attempt a fix.',
                  files: [{ path: 'src/index.ts', content: 'export const stillBroken = true;\n' }],
                  commitMessage: 'fix: maybe',
                  validationPlan: ['Run make check'],
                  resumeStatus: 'Ready',
                },
                issueComment: 'Try a fix.',
              },
            },
          };
        },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: false, summary: 'make check failed', logs: 'still broken' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return { branchName: worktree.branchName, pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42' }; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); assert.match(input.body, /Validation failure:/); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'needs_human');
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence',
      'writeRepositoryFiles',
      'runQualityGate',
      'runAgentSequence',
      'writeRepositoryFiles',
      'runQualityGate',
      'upsertIssueComment:escalation:human-needed',
      `move:${issue.blockedOptionId}`,
    ]);
  });

  it('falls back to human-needed when the agent explicitly requests human input', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];

    const result = await runEscalationPhase(
      { issue, originPhase: 'specify', worktree },
      {
        async createWorktreeForIssueIfNeeded() { return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async getPullRequestDetails() { throw new Error('should not request PR'); },
        async getPullRequestDiff() { throw new Error('should not request diff'); },
        async listPullRequestFiles() { throw new Error('should not request files'); },
        async listPullRequestReviewComments() { throw new Error('should not request review comments'); },
        async runAgentSequence() {
          calls.push('runAgentSequence');
          return {
            outputs: {
              [ESCALATION_RESPONSE_OUTPUT_KEY]: {
                outcome: 'needs_human',
                originPhase: 'specify',
                confidence: 'low',
                rootCause: {
                  category: 'ambiguous_requirement',
                  summary: 'The spec is ambiguous.',
                  evidence: ['The ticket does not choose one of two valid API shapes.'],
                },
                resolution: {
                  summary: 'No safe automated change.',
                  files: [],
                  validationPlan: [],
                  resumeStatus: 'Backlog',
                },
                humanRequest: {
                  question: 'Choose the API shape, then move the ticket back to Backlog.',
                  recommendedStatusAfterAnswer: 'Backlog',
                },
                issueComment: 'Need a human decision.',
              },
            },
          };
        },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'ok', logs: '' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return { branchName: worktree.branchName, pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42' }; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'needs_human');
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence',
      'upsertIssueComment:escalation:human-needed',
      `move:${issue.blockedOptionId}`,
    ]);
  });

  it('falls back to human-needed when the escalation agent fails unexpectedly', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];

    const result = await runEscalationPhase(
      { issue, originPhase: 'implement', worktree },
      {
        async createWorktreeForIssueIfNeeded() { return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async getPullRequestDetails() { throw new Error('should not request PR'); },
        async getPullRequestDiff() { throw new Error('should not request diff'); },
        async listPullRequestFiles() { throw new Error('should not request files'); },
        async listPullRequestReviewComments() { throw new Error('should not request review comments'); },
        async runAgentSequence() { calls.push('runAgentSequence'); throw new Error('provider timeout'); },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async writeRepositoryFiles() { calls.push('writeRepositoryFiles'); },
        async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
        async runQualityGate() { calls.push('runQualityGate'); return { passed: true, summary: 'ok', logs: '' }; },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return { branchName: worktree.branchName, pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42' }; },
        async upsertIssueComment(input) { calls.push(`upsertIssueComment:${input.marker}`); assert.match(input.body, /provider timeout/); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'needs_human');
    assert.deepStrictEqual(calls, [
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence',
      'upsertIssueComment:escalation:human-needed',
      `move:${issue.blockedOptionId}`,
    ]);
  });
});