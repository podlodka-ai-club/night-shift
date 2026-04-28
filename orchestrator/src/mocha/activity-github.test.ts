import assert from 'assert';
import { describe, it } from 'mocha';
import { buildIssueComment } from '../activities';
import {
  createFetchSequenceMock,
  type FetchCall,
  buildExpectedCreatedPullRequest,
  buildOpenPullRequestLookupUrl,
  buildProjectItemNode,
  buildProjectQueryResponse,
  buildPullRequestsApiUrl,
  buildSelectedIssue,
  buildWorktreeContext,
  createActivityTestRig,
  jsonResponse,
} from './activity-test-helpers';

describe('github activities', () => {
  it('selects the first ready issue from the project response', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const { getTopReadyIssue } = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([jsonResponse(buildProjectQueryResponse(selectedIssue))], fetchCalls) },
    });

    const issue = await getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 });

    assert.deepStrictEqual(issue, selectedIssue);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.github.com/graphql');
    assert.strictEqual(fetchCalls[0].init?.method, 'POST');
    assert.match(String(fetchCalls[0].init?.body), /owner: user\(login: \$login\)/);
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)).variables, {
      login: 'Mugenor',
      number: 1,
      itemsFirst: 100,
      itemsAfter: null,
    });
  });

  it('falls back to an organization-owned project when the login is not a user', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const { getTopReadyIssue } = createActivityTestRig({
      github: {
        fetch: createFetchSequenceMock(
          [
            jsonResponse({ data: { owner: null }, errors: [{ message: "Could not resolve to a User with the login of 'Mugenor'." }] }),
            jsonResponse(buildProjectQueryResponse(selectedIssue)),
          ],
          fetchCalls,
        ),
      },
    });

    const issue = await getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 });

    assert.deepStrictEqual(issue, selectedIssue);
    assert.strictEqual(fetchCalls.length, 2);
    assert.match(String(fetchCalls[0].init?.body), /owner: user\(login: \$login\)/);
    assert.match(String(fetchCalls[1].init?.body), /owner: organization\(login: \$login\)/);
  });

  it('paginates project items until it finds a Ready issue on a later page', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const { getTopReadyIssue } = createActivityTestRig({
      github: {
        fetch: createFetchSequenceMock(
          [
            jsonResponse(
              buildProjectQueryResponse(selectedIssue, {
                hasNextPage: true,
                endCursor: 'cursor-1',
                items: [buildProjectItemNode(selectedIssue, { id: 'item-non-ready', statusName: 'In progress' })],
              }),
            ),
            jsonResponse(buildProjectQueryResponse(selectedIssue)),
          ],
          fetchCalls,
        ),
      },
    });

    const issue = await getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 });

    assert.deepStrictEqual(issue, selectedIssue);
    assert.strictEqual(fetchCalls.length, 2);
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)).variables.itemsAfter, 'cursor-1');
  });

  it('lists matching project issues sorted by createdAt and selects the oldest Ready item', async () => {
    const newerReady = buildSelectedIssue();
    const olderReady = {
      ...buildSelectedIssue(),
      projectItemId: 'item-5',
      issueNumber: 5,
      issueTitle: 'Older ready issue',
      taskDescription: 'Older ready task',
      issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/5',
    };
    const backlogIssue = {
      ...buildSelectedIssue(),
      projectItemId: 'item-3',
      issueNumber: 3,
      issueTitle: 'Backlog issue',
      taskDescription: 'Backlog task',
      issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/3',
    };
    const fetchCalls: FetchCall[] = [];
    const { getTopReadyIssue, listProjectIssuesByStatus } = createActivityTestRig({
      github: {
        fetch: createFetchSequenceMock([
          jsonResponse(
            buildProjectQueryResponse(newerReady, {
              items: [
                buildProjectItemNode(newerReady, {
                  id: 'item-7',
                  statusName: 'Ready',
                  createdAt: '2026-04-28T11:00:00.000Z',
                }),
                buildProjectItemNode(backlogIssue, {
                  id: 'item-3',
                  statusName: 'Backlog',
                  createdAt: '2026-04-28T09:00:00.000Z',
                }),
                buildProjectItemNode(olderReady, {
                  id: 'item-5',
                  statusName: 'Ready',
                  createdAt: '2026-04-28T08:00:00.000Z',
                }),
              ],
            }),
          ),
          jsonResponse(
            buildProjectQueryResponse(newerReady, {
              items: [
                buildProjectItemNode(newerReady, {
                  id: 'item-7',
                  statusName: 'Ready',
                  createdAt: '2026-04-28T11:00:00.000Z',
                }),
                buildProjectItemNode(olderReady, {
                  id: 'item-5',
                  statusName: 'Ready',
                  createdAt: '2026-04-28T08:00:00.000Z',
                }),
              ],
            }),
          ),
        ], fetchCalls),
      },
    });

    const listedIssues = await listProjectIssuesByStatus({
      projectOwner: 'Mugenor',
      projectNumber: 1,
      statusNames: ['Backlog', 'Ready'],
    });
    const selectedIssue = await getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 });

    assert.deepStrictEqual(
      listedIssues.map((issue) => [issue.issueNumber, issue.currentStatusName, issue.createdAt]),
      [
        [5, 'Ready', '2026-04-28T08:00:00.000Z'],
        [3, 'Backlog', '2026-04-28T09:00:00.000Z'],
        [7, 'Ready', '2026-04-28T11:00:00.000Z'],
      ],
    );
    assert.strictEqual(selectedIssue.issueNumber, 5);
    assert.strictEqual(fetchCalls.length, 2);
  });

  it('creates missing canonical project status options before selecting the Ready issue', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const { getTopReadyIssue } = createActivityTestRig({
      github: {
        fetch: createFetchSequenceMock(
          [
            jsonResponse(
              buildProjectQueryResponse(selectedIssue, {
                statusOptions: [
                  {
                    id: selectedIssue.readyOptionId,
                    name: selectedIssue.readyStatusName,
                    color: 'GREEN',
                    description: 'Already ready',
                  },
                  { id: selectedIssue.inProgressOptionId, name: 'In progress', color: 'YELLOW' },
                  { id: selectedIssue.inReviewOptionId, name: selectedIssue.inReviewStatusName, color: 'PURPLE' },
                  { id: 'custom-option', name: 'Custom', color: 'ORANGE', description: 'Custom lane' },
                ],
              }),
            ),
            jsonResponse({
              data: {
                updateProjectV2Field: {
                  projectV2Field: {
                    id: selectedIssue.statusFieldId,
                    options: [
                      { id: 'backlog-option', name: 'Backlog' },
                      { id: 'refinement-option', name: 'Refinement' },
                      { id: 'refined-option', name: 'Refined' },
                      { id: selectedIssue.readyOptionId, name: selectedIssue.readyStatusName },
                      { id: selectedIssue.inProgressOptionId, name: 'In progress' },
                      { id: selectedIssue.inReviewOptionId, name: selectedIssue.inReviewStatusName },
                      { id: 'ready-to-merge-option', name: 'Ready to merge' },
                      { id: selectedIssue.blockedOptionId, name: 'Blocked' },
                      { id: 'custom-option', name: 'Custom' },
                    ],
                  },
                },
              },
            }),
          ],
          fetchCalls,
        ),
      },
    });

    const issue = await getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 });

    assert.deepStrictEqual(issue, selectedIssue);
    assert.strictEqual(fetchCalls.length, 2);
    assert.match(String(fetchCalls[1].init?.body), /updateProjectV2Field/);
    const mutationVariables = JSON.parse(String(fetchCalls[1].init?.body)).variables;
    assert.strictEqual(mutationVariables.input.fieldId, selectedIssue.statusFieldId);
    assert.deepStrictEqual(mutationVariables.input.singleSelectOptions, [
      { name: 'Backlog', color: 'GRAY', description: 'orchestrator auto-created status: Backlog' },
      { name: 'Refinement', color: 'BLUE', description: 'orchestrator auto-created status: Refinement' },
      { name: 'Refined', color: 'BLUE', description: 'orchestrator auto-created status: Refined' },
      { name: 'Ready', color: 'GREEN', description: 'Already ready' },
      { name: 'In progress', color: 'YELLOW', description: '' },
      { name: 'In review', color: 'PURPLE', description: '' },
      { name: 'Ready to merge', color: 'GREEN', description: 'orchestrator auto-created status: Ready to merge' },
      { name: 'Blocked', color: 'RED', description: 'orchestrator auto-created status: Blocked' },
      { name: 'Custom', color: 'ORANGE', description: 'Custom lane' },
    ]);
  });

  it('opens the pull request using the stable issue branch', async () => {
    const worktree = buildWorktreeContext();
    const fetchCalls: FetchCall[] = [];
    const { openPullRequest } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return (init?.method ?? 'GET') === 'GET'
          ? jsonResponse([])
          : jsonResponse({ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` });
      } },
    });

    const pullRequest = await openPullRequest({ worktree });

    assert.deepStrictEqual(pullRequest, buildExpectedCreatedPullRequest(worktree));
    assert.deepStrictEqual(
      fetchCalls.map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
      [
        { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
        { url: buildPullRequestsApiUrl(worktree), method: 'POST' },
      ],
    );
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
      title: `chore: dummy change for #${worktree.issueNumber}`,
      head: worktree.branchName,
      base: worktree.defaultBranch,
      body: `Automated dummy change for ${worktree.issueUrl}`,
      draft: false,
    });
  });

  it('uses agent-provided pull request metadata when opening a pull request', async () => {
    const worktree = buildWorktreeContext();
    const fetchCalls: FetchCall[] = [];
    const { openPullRequest } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return (init?.method ?? 'GET') === 'GET'
          ? jsonResponse([])
          : jsonResponse({ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` });
      } },
    });

    await openPullRequest({
      worktree,
      title: 'feat: generate commit and PR metadata',
      body: '## Summary\n- ask Codex for structured metadata in the same thread',
    });

    assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
      title: 'feat: generate commit and PR metadata',
      head: worktree.branchName,
      base: worktree.defaultBranch,
      body: '## Summary\n- ask Codex for structured metadata in the same thread',
      draft: false,
    });
  });

  it('reuses an existing open pull request for the issue branch', async () => {
    const worktree = buildWorktreeContext();
    const fetchCalls: FetchCall[] = [];
    const { openPullRequest } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return jsonResponse([{ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` }]);
      } },
    });

    const pullRequest = await openPullRequest({ worktree });

    assert.deepStrictEqual(pullRequest, buildExpectedCreatedPullRequest(worktree));
    assert.deepStrictEqual(fetchCalls, [
      {
        url: buildOpenPullRequestLookupUrl(worktree),
        init: {
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      },
    ]);
  });

  it('updates an existing open pull request when asked to refresh draft metadata', async () => {
    const worktree = buildWorktreeContext();
    const fetchCalls: FetchCall[] = [];
    const { openPullRequest } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return (init?.method ?? 'GET') === 'GET'
          ? jsonResponse([{ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` }])
          : jsonResponse({ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` });
      } },
    });

    await openPullRequest({ worktree, title: 'Spec: #7 Create a dummy PR', body: 'Draft spec PR body', draft: true, updateIfExists: true });

    assert.deepStrictEqual(
      fetchCalls.map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
      [
        { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
        { url: `${buildPullRequestsApiUrl(worktree)}/42`, method: 'PATCH' },
      ],
    );
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
      title: 'Spec: #7 Create a dummy PR',
      body: 'Draft spec PR body',
    });
  });

  it('recovers from a duplicate-create PR race by re-querying the branch PR', async () => {
    const worktree = buildWorktreeContext();
    const fetchCalls: FetchCall[] = [];
    const lookupResponses = [jsonResponse([]), jsonResponse([{ number: 42, html_url: `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/42` }])];
    const { openPullRequest } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        if ((init?.method ?? 'GET') === 'GET') {
          const response = lookupResponses.shift();
          if (!response) {
            throw new Error('Unexpected extra pull request lookup.');
          }
          return response;
        }

        return jsonResponse(
          {
            message: 'Validation Failed',
            errors: [{ message: `A pull request already exists for ${worktree.repoOwner}:${worktree.branchName}.` }],
          },
          422,
        );
      } },
    });

    const pullRequest = await openPullRequest({ worktree });

    assert.deepStrictEqual(pullRequest, buildExpectedCreatedPullRequest(worktree));
    assert.deepStrictEqual(
      fetchCalls.map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
      [
        { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
        { url: buildPullRequestsApiUrl(worktree), method: 'POST' },
        { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
      ],
    );
  });

  it('reads pull request review context from GitHub', async () => {
    const fetchCalls: FetchCall[] = [];
    const { getPullRequestDetails, getPullRequestDiff, listPullRequestFiles, listPullRequestReviewComments } = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([
        jsonResponse({ number: 42, html_url: 'https://github.com/Mugenor/orchestrator-testing/pull/42', draft: true, head: { sha: 'abc123' } }),
        new Response('diff --git a/src/index.ts b/src/index.ts', { status: 200 }),
        jsonResponse([{ filename: 'src/index.ts', patch: '@@\n+export const ok = true;' }]),
        jsonResponse([{ id: 9, body: 'Human note', path: 'src/index.ts', line: 1 }]),
      ], fetchCalls) },
    });

    assert.deepStrictEqual(await getPullRequestDetails({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42 }), {
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42',
      headSha: 'abc123',
      isDraft: true,
    });
    assert.strictEqual(await getPullRequestDiff({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42 }), 'diff --git a/src/index.ts b/src/index.ts');
    assert.deepStrictEqual(await listPullRequestFiles({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42 }), [{ path: 'src/index.ts', patch: '@@\n+export const ok = true;' }]);
    assert.deepStrictEqual(await listPullRequestReviewComments({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42 }), [{ id: 9, body: 'Human note', path: 'src/index.ts', line: 1 }]);
    assert.strictEqual(String(fetchCalls[1].init?.headers && (fetchCalls[1].init?.headers as Record<string, string>).Accept), 'application/vnd.github.v3.diff');
  });

  it('marks a draft pull request ready and upserts inline review comments', async () => {
    const fetchCalls: FetchCall[] = [];
    const { setPullRequestReady, upsertPullRequestReviewComment } = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([
        jsonResponse({ number: 42, html_url: 'https://github.com/Mugenor/orchestrator-testing/pull/42', draft: true, node_id: 'PR_node_42' }),
        jsonResponse({ data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_node_42' } } } }),
        jsonResponse([]),
        jsonResponse({ id: 55 }),
      ], fetchCalls) },
    });

    await setPullRequestReady({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42, ready: true });
    await upsertPullRequestReviewComment({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42, commitId: 'abc123', marker: 'review:finding', body: 'New body', path: 'src/index.ts', line: 1 });

    assert.match(String(fetchCalls[1].init?.body), /markPullRequestReadyForReview/);
    assert.deepStrictEqual(
      fetchCalls.slice(2).map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
      [
        { url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/pulls/42/comments?per_page=100', method: 'GET' },
        { url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/pulls/42/comments', method: 'POST' },
      ],
    );
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[3].init?.body)), { body: '<!-- night-shift:review:finding -->\nNew body', commit_id: 'abc123', path: 'src/index.ts', line: 1, side: 'RIGHT' });
  });

  it('submits a top-level pull request review', async () => {
    const fetchCalls: FetchCall[] = [];
    const { createPullRequestReview } = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([jsonResponse({ id: 99 })], fetchCalls) },
    });

    await createPullRequestReview({ repoOwner: 'Mugenor', repoName: 'orchestrator-testing', pullRequestNumber: 42, event: 'APPROVE', body: 'LGTM' });

    assert.deepStrictEqual(fetchCalls, [
      {
        url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/pulls/42/reviews',
        init: {
          method: 'POST',
          body: JSON.stringify({ event: 'APPROVE', body: 'LGTM' }),
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      },
    ]);
  });

  it('comments on the issue with the opened pull request URL', async () => {
    const fetchCalls: FetchCall[] = [];
    const { commentOnIssue } = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([jsonResponse({ id: 99 })], fetchCalls) },
    });

    await commentOnIssue({
      repoOwner: 'Mugenor',
      repoName: 'orchestrator-testing',
      issueNumber: 7,
      pullRequestUrl: 'https://github.com/Mugenor/orchestrator-testing/pull/42',
    });

    assert.deepStrictEqual(fetchCalls, [
      {
        url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/issues/7/comments',
        init: {
          method: 'POST',
          body: JSON.stringify({
            body: 'Opened a pull request for this issue: https://github.com/Mugenor/orchestrator-testing/pull/42',
          }),
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      },
    ]);
  });

  it('adds escalation labels to an issue', async () => {
    const fetchCalls: FetchCall[] = [];
    const activities = createActivityTestRig({
      github: { fetch: createFetchSequenceMock([jsonResponse({ labels: [{ name: 'night-shift:escalation' }] })], fetchCalls) },
    }) as ReturnType<typeof createActivityTestRig> & {
      addIssueLabels?: (input: { repoOwner: string; repoName: string; issueNumber: number; labels: string[] }) => Promise<void>;
    };

    assert.strictEqual(typeof activities.addIssueLabels, 'function');
    if (!activities.addIssueLabels) return;

    await activities.addIssueLabels({
      repoOwner: 'Mugenor',
      repoName: 'orchestrator-testing',
      issueNumber: 7,
      labels: ['night-shift:escalation'],
    });

    assert.deepStrictEqual(fetchCalls, [
      {
        url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/issues/7/labels',
        init: {
          method: 'POST',
          body: JSON.stringify({ labels: ['night-shift:escalation'] }),
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      },
    ]);
  });

  it('upserts a marker comment instead of creating duplicates', async () => {
    const fetchCalls: FetchCall[] = [];
    const { upsertIssueComment } = createActivityTestRig({
      github: { fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return (init?.method ?? 'GET') === 'GET'
          ? jsonResponse([{ id: 55, body: '<!-- night-shift:specify:summary -->\nOld summary' }])
          : jsonResponse({ id: 55 });
      } },
    });

    await upsertIssueComment({
      repoOwner: 'Mugenor',
      repoName: 'orchestrator-testing',
      issueNumber: 7,
      marker: 'specify:summary',
      body: 'New summary',
    });

    assert.deepStrictEqual(
      fetchCalls.map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
      [
        { url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/issues/7/comments', method: 'GET' },
        { url: 'https://api.github.com/repos/Mugenor/orchestrator-testing/issues/comments/55', method: 'PATCH' },
      ],
    );
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
      body: '<!-- night-shift:specify:summary -->\nNew summary',
    });
  });

  it('moves the GitHub project item status via GraphQL', async () => {
    const fetchCalls: FetchCall[] = [];
    const { moveProjectItemStatus } = createActivityTestRig({
      github: {
        fetch: createFetchSequenceMock(
          [jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-1' } } } })],
          fetchCalls,
        ),
      },
    });

    await moveProjectItemStatus({
      projectId: 'project-1',
      projectItemId: 'item-1',
      statusFieldId: 'status-field-1',
      statusOptionId: 'option-in-review',
    });

    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.github.com/graphql');
    assert.strictEqual(fetchCalls[0].init?.method, 'POST');
    assert.match(String(fetchCalls[0].init?.body), /updateProjectV2ItemFieldValue/);
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)).variables, {
      projectId: 'project-1',
      itemId: 'item-1',
      fieldId: 'status-field-1',
      optionId: 'option-in-review',
    });
  });

  it('builds the issue comment helper', () => {
    assert.strictEqual(
      buildIssueComment('https://github.com/Mugenor/orchestrator-testing/pull/42'),
      'Opened a pull request for this issue: https://github.com/Mugenor/orchestrator-testing/pull/42',
    );
  });
});