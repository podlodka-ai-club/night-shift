import { describe, expect, it, vi } from 'vitest';
import { ReportPublisher } from '../../src/github/ReportPublisher';
import type { RunState } from '../../src/types';

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    ticketId: 'ticket-1',
    repoOwner: 'owner',
    repoName: 'repo',
    branch: 'feature/ticket-1',
    stage: 'blocked',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ReportPublisher.addBlockedComment', () => {
  it('uses blockedAtStage when present', async () => {
    const github = {
      addPRComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
    } as never;
    const publisher = new ReportPublisher(github);

    await publisher.addBlockedComment(
      makeState({ issueNumber: 42, blockedAtStage: 'validated' }),
      'PR creation failed',
      7,
    );

    expect(github.addPRComment).toHaveBeenCalledTimes(1);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.addPRComment.mock.calls[0][1]).toContain('**Stage:** `validated`');
  });
});