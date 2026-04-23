import { describe, it, expect, vi, beforeEach, MockedFunction } from 'vitest';
import type { Config } from '../../src/config';

// Stub Octokit modules before importing the adapter.
vi.mock('@octokit/graphql', () => ({
  graphql: {
    defaults: vi.fn(() => vi.fn()),
  },
}));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    issues: { createComment: vi.fn().mockResolvedValue({}) },
    pulls: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { number: 42, html_url: 'https://github.com/o/r/pull/42' } }),
      update: vi.fn().mockResolvedValue({}),
    },
  })),
}));

import { GitHubAdapter } from '../../src/github/GitHubAdapter';
import { graphql } from '@octokit/graphql';

function makeConfig(): Config {
  return {
    github: {
      token: 'tok', projectOwner: 'owner', projectOwnerType: 'user',
      projectNumber: 1, repoOwner: 'owner', repoName: 'repo',
      defaultBranch: 'main', statusFieldName: 'Status',
      statusValues: { ready: 'Ready', inProgress: 'In progress', inReview: 'In review', blocked: 'Blocked' },
    },
    anthropic: { apiKey: 'key', model: 'claude-sonnet-4-6' },
    codex: { enabled: false, model: 'gpt-5-mini' },
    budgets: { specify: 0.5, implement: 2, review: 0.5, totalPerTicket: 5 },
    pricing: {
      codex: { inputPer1kTokens: 0.00075, outputPer1kTokens: 0.0045 },
      sonnet: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    },
    dataDir: '/tmp', repoDir: '/tmp/repo',
  } as Config;
}

describe('GitHubAdapter.initialize', () => {
  it('parses project fields and option IDs from GraphQL response', async () => {
    const mockGql = vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          id: 'PVT_123',
          fields: {
            nodes: [
              {
                id: 'FIELD_1',
                name: 'Status',
                options: [
                  { id: 'OPT_R', name: 'Ready' },
                  { id: 'OPT_IP', name: 'In progress' },
                  { id: 'OPT_IR', name: 'In review' },
                  { id: 'OPT_B', name: 'Blocked' },
                ],
              },
            ],
          },
        },
      },
    });
    vi.mocked(graphql.defaults).mockReturnValue(mockGql);

    const adapter = new GitHubAdapter(makeConfig());
    await adapter.initialize();

    // Verify a status mutation call would use the correct IDs.
    mockGql.mockResolvedValueOnce({});
    await adapter.updateItemStatus('ITEM_1', 'Ready');

    const [, variables] = mockGql.mock.calls[1];
    expect(variables.projectId).toBe('PVT_123');
    expect(variables.fieldId).toBe('FIELD_1');
    expect(variables.optionId).toBe('OPT_R');
  });

  it('throws if Status field is not found', async () => {
    const mockGql = vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          id: 'PVT_1',
          fields: { nodes: [] },
        },
      },
    });
    vi.mocked(graphql.defaults).mockReturnValue(mockGql);

    const adapter = new GitHubAdapter(makeConfig());
    await expect(adapter.initialize()).rejects.toThrow('not found');
  });
});

describe('GitHubAdapter.listReadyItems', () => {
  it('filters items by Ready status', async () => {
    const mockGql = vi.fn()
      // initialize()
      .mockResolvedValueOnce({
        user: {
          projectV2: {
            id: 'PVT_1',
            fields: {
              nodes: [
                {
                  id: 'F1', name: 'Status',
                  options: [
                    { id: 'OPT_R', name: 'Ready' },
                    { id: 'OPT_IP', name: 'In progress' },
                    { id: 'OPT_IR', name: 'In review' },
                    { id: 'OPT_B', name: 'Blocked' },
                  ],
                },
              ],
            },
          },
        },
      })
      // listReadyItems()
      .mockResolvedValueOnce({
        node: {
          items: {
            nodes: [
              {
                id: 'ITEM_A',
                fieldValues: {
                  nodes: [{ name: 'Ready', field: { name: 'Status' } }],
                },
                content: { number: 1, title: 'Ready task', body: 'body', url: 'url' },
              },
              {
                id: 'ITEM_B',
                fieldValues: {
                  nodes: [{ name: 'In progress', field: { name: 'Status' } }],
                },
                content: { number: 2, title: 'In progress task', body: '', url: '' },
              },
            ],
          },
        },
      });
    vi.mocked(graphql.defaults).mockReturnValue(mockGql);

    const adapter = new GitHubAdapter(makeConfig());
    await adapter.initialize();
    const items = await adapter.listReadyItems();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('ITEM_A');
    expect(items[0].issueTitle).toBe('Ready task');
  });
});

describe('GitHubAdapter.createPR', () => {
  it('calls REST API and returns number and url', async () => {
    const mockGql = vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          id: 'PVT_1',
          fields: {
            nodes: [
              {
                id: 'F1', name: 'Status',
                options: [{ id: 'OPT_R', name: 'Ready' }],
              },
            ],
          },
        },
      },
    });
    vi.mocked(graphql.defaults).mockReturnValue(mockGql);

    const adapter = new GitHubAdapter(makeConfig());
    await adapter.initialize();

    const pr = await adapter.createPR({ title: 'Test', body: 'body', head: 'feature', base: 'main' });
    expect(pr.number).toBe(42);
    expect(pr.url).toContain('pull/42');
  });

  it('finds an existing open PR by head branch', async () => {
    const mockGql = vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          id: 'PVT_1',
          fields: {
            nodes: [
              {
                id: 'F1', name: 'Status',
                options: [{ id: 'OPT_R', name: 'Ready' }],
              },
            ],
          },
        },
      },
    });
    vi.mocked(graphql.defaults).mockReturnValue(mockGql);

    const adapter = new GitHubAdapter(makeConfig());
    await adapter.initialize();

    const existing = await adapter.findOpenPRByHead('feature');
    expect(existing).toBeNull();
  });
});
