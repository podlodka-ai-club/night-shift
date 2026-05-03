import assert from 'assert';
import { describe, it } from 'mocha';
import { buildEscalationPrompt } from '../phases/escalation/prompt';
import { buildSelectedIssue, buildWorktreeContext } from './activity-test-helpers';

describe('escalation prompt', () => {
  it('renders operator comments separately from Night Shift summaries and includes PR context', () => {
    const prompt = buildEscalationPrompt({
      issue: buildSelectedIssue(),
      originPhase: 'review',
      blockedReason: 'review_escalation',
      failureSummary: 'Review escalated after repeated error findings.',
      changeName: '7-demo-change',
      worktree: buildWorktreeContext(),
      issueComments: [
        { id: 1, body: 'Operator note: keep the surface area small.' },
        { id: 2, body: '<!-- night-shift:implement:summary -->\n## Implement summary\n- Summary: prior bot summary' },
      ],
      specBundleFiles: [
        { path: 'proposal.md', content: '# Proposal' },
        { path: 'tasks.md', content: '# Tasks' },
      ],
      pullRequest: { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42', headSha: 'abc123', isDraft: false },
      diff: 'diff --git a/src/index.ts b/src/index.ts\n+export const ok = true;',
      changedFiles: [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }],
      reviewComments: [{ id: 7, path: 'src/index.ts', line: 1, body: 'Human note: keep this tiny.' }],
      validationError: 'make check failed',
      maxDiffCharacters: 40,
    });

    assert.match(prompt, /Operator note: keep the surface area small\./);
    assert.doesNotMatch(prompt, /night-shift:implement:summary/);
    assert.match(prompt, /## Implement summary/);
    assert.match(prompt, /Pull request: https:\/\/github.com\/Mugenor\/orchestrator-testing\/pull\/42/);
    assert.match(prompt, /Human note: keep this tiny\./);
    assert.match(prompt, /Diff truncated to 40 characters|```diff/);
    assert.match(prompt, /make check failed/);
  });

  it('renders no-PR escalation context for infrastructure failures', () => {
    const prompt = buildEscalationPrompt({
      issue: buildSelectedIssue(),
      originPhase: 'implement',
      failureSummary: 'The agent failed before any PR details were available.',
      changeName: '7-demo-change',
      worktree: buildWorktreeContext(),
      issueComments: [],
      specBundleFiles: [],
    });

    assert.match(prompt, /Origin phase: implement/);
    assert.match(prompt, /The agent failed before any PR details were available\./);
    assert.match(prompt, /## Pull request context\n- \(none\)/);
    assert.match(prompt, /Return JSON only matching the required schema\./);
  });
});