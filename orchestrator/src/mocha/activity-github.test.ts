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