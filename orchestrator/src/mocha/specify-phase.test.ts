import assert from 'assert';
import { describe, it } from 'mocha';
import { buildExpectedCreatedPullRequest, buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';
import { buildSpecifyPrompt } from '../phases/specify/prompt';
import { runSpecifyPhase } from '../phases/specify/phase';
import { SpecifyPhaseContractError } from '../phases/specify/errors';

describe('specify phase', () => {
  it('renders the prompt with operator comments, existing drafts, and validation feedback while filtering Night Shift markers', () => {
    const prompt = buildSpecifyPrompt({
      issue: buildSelectedIssue(),
      changeName: '7-demo-change',
      issueComments: [
        { id: 1, body: 'Customer note: keep the API small.' },
        { id: 2, body: '<!-- night-shift:specify:summary -->\nold summary' },
      ],
      currentDraftFiles: [{ path: 'proposal.md', content: '# Existing Proposal' }],
      validationError: 'proposal.md failed validation',
    });

    assert.match(prompt, /Customer note: keep the API small\./);
    assert.doesNotMatch(prompt, /night-shift:specify:summary/);
    assert.match(prompt, /# Existing Proposal/);
    assert.match(prompt, /proposal\.md failed validation/);
  });

  it('retries once after validation failure and only performs refined-side effects once', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const pullRequest = buildExpectedCreatedPullRequest(worktree);
    const calls: string[] = [];
    let validateCallCount = 0;
    let runAgentSequenceCallCount = 0;

    const result = await runSpecifyPhase(
      { issue },
      {
        async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
        async listIssueComments() { calls.push('listIssueComments'); return []; },
        async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
        async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
        async validateOpenSpecChange() {
          validateCallCount += 1;
          calls.push(`validate:${validateCallCount}`);
          if (validateCallCount === 1) throw new Error('proposal.md failed validation');
        },
        async runAgentSequence() {
          runAgentSequenceCallCount += 1;
          calls.push(`runAgentSequence:${runAgentSequenceCallCount}`);
          return {
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
            },
          };
        },
        async commitAndPush() { calls.push('commitAndPush'); },
        async openPullRequest() { calls.push('openPullRequest'); return pullRequest; },
        async upsertIssueComment() { calls.push('upsertIssueComment'); },
        async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
      },
    );

    assert.strictEqual(result.outcome, 'refined');
    assert.strictEqual(runAgentSequenceCallCount, 2);
    assert.strictEqual(validateCallCount, 2);
    assert.deepStrictEqual(calls, [
      `move:${issue.refinementOptionId}`,
      'createWorktree',
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence:1',
      'writeOpenSpecChangeFiles',
      'validate:1',
      'runAgentSequence:2',
      'writeOpenSpecChangeFiles',
      'validate:2',
      'commitAndPush',
      'openPullRequest',
      'upsertIssueComment',
      `move:${issue.refinedOptionId}`,
    ]);
  });

  it('raises a SpecifyPhaseContractError without follow-on GitHub side effects when the structured payload is invalid', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const calls: string[] = [];

    await assert.rejects(
      () => runSpecifyPhase(
        { issue },
        {
          async createWorktreeForIssueIfNeeded() { calls.push('createWorktree'); return worktree; },
          async listIssueComments() { calls.push('listIssueComments'); return []; },
          async readOpenSpecChangeFiles() { calls.push('readOpenSpecChangeFiles'); return []; },
          async writeOpenSpecChangeFiles() { calls.push('writeOpenSpecChangeFiles'); },
          async validateOpenSpecChange() { calls.push('validateOpenSpecChange'); },
          async runAgentSequence() {
            calls.push('runAgentSequence');
            const error = new Error('invalid structured payload');
            error.name = 'AgentContractError';
            throw error;
          },
          async commitAndPush() { calls.push('commitAndPush'); },
          async openPullRequest() { calls.push('openPullRequest'); throw new Error('should not open pull request'); },
          async upsertIssueComment() { calls.push('upsertIssueComment'); },
          async moveProjectItemStatus(input) { calls.push(`move:${input.statusOptionId}`); },
        },
      ),
      (error: unknown) => error instanceof SpecifyPhaseContractError,
    );

    assert.deepStrictEqual(calls, [
      `move:${issue.refinementOptionId}`,
      'createWorktree',
      'listIssueComments',
      'readOpenSpecChangeFiles',
      'runAgentSequence',
    ]);
  });
});