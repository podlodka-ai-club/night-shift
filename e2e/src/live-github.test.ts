import assert from 'assert';
import { describe, it } from 'mocha';
import type { GitHubClientDeps } from '../../orchestrator/lib/activity-deps';
import { buildNightShiftMarker } from '../../orchestrator/lib/activity-github';
import type { AutomateReadyIssueResult, SelectedProjectIssue } from '../../orchestrator/lib/shared';
import type { E2EConfig } from './config';
import { FAKE_AGENT_FILE_PATH, buildFakeAgentFileText } from './fake-agent';
import {
  assertSeededIssueWillBeSelected,
  assertWorkflowArtifacts,
  cleanupRunArtifacts,
  getProjectItemStatusName,
  seedIssueInProject,
  type SeededIssue,
} from './live-github';

const TEST_REPO_OWNER = 'Mugenor';
const TEST_REPO_NAME = 'orchestrator-testing';
const TEST_RUN_ID = 'run-123';

function createTestConfig(): E2EConfig {
  return {
    targetRepo: { owner: TEST_REPO_OWNER, name: TEST_REPO_NAME },
    projectOwner: TEST_REPO_OWNER,
    projectNumber: 1,
    agentMode: 'fake',
    cleanup: true,
    preserveOnFailure: true,
    githubToken: 'test-token',
  };
}

function createSeededIssue(runId = TEST_RUN_ID): SeededIssue {
  return {
    runId,
    issueNumber: 77,
    issueUrl: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
    projectId: 'PVT_project',
    projectItemId: 'PVT_item',
    statusFieldId: 'PVT_field',
  };
}

function createSelectedIssue(issueUrl: string): SelectedProjectIssue {
  return {
    projectId: 'PVT_project',
    projectItemId: 'PVT_item',
    statusFieldId: 'PVT_field',
    backlogOptionId: 'backlog',
    refinementOptionId: 'refinement',
    refinedOptionId: 'refined',
    readyOptionId: 'ready',
    inProgressOptionId: 'in-progress',
    inReviewOptionId: 'in-review',
    readyToMergeOptionId: 'ready-to-merge',
    blockedOptionId: 'blocked',
    issueNumber: 77,
    issueTitle: 'Seeded issue',
    taskDescription: 'Create a deterministic change',
    issueUrl,
    repoOwner: TEST_REPO_OWNER,
    repoName: TEST_REPO_NAME,
    defaultBranch: 'main',
    backlogStatusName: 'Backlog',
    refinementStatusName: 'Refinement',
    refinedStatusName: 'Refined',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    readyToMergeStatusName: 'Ready to merge',
  };
}

function createWorkflowResult(overrides: Partial<AutomateReadyIssueResult> = {}): AutomateReadyIssueResult {
  return {
    issueNumber: 77,
    issueTitle: 'Seeded issue',
    issueUrl: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
    pullRequestNumber: 12,
    pullRequestUrl: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pull/12`,
    branchName: 'orchestrator-e2e-run-123/issue-77',
    filePath: 'orchestrator-e2e/run-123/issue-77.md',
    targetStatusName: 'Ready to merge',
    ...overrides,
  };
}

type ProjectSelectionItem = {
  itemId: string;
  statusName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
};

function createProjectSelectionResponse(
  ...args:
    | [options?: { statusOptions?: Array<{ id: string; name: string }> }, ...items: ProjectSelectionItem[]]
    | ProjectSelectionItem[]
) {
  const [firstArg, ...restArgs] = args;
  const hasOptions = firstArg !== undefined && !('itemId' in firstArg);
  const options = hasOptions ? firstArg : undefined;
  const items = (hasOptions ? restArgs : args) as ProjectSelectionItem[];

  return {
    owner: {
      projectV2: {
        id: 'PVT_project',
        fields: { nodes: [buildStatusField(options?.statusOptions)] },
        items: {
          nodes: items.map((item) => ({
            id: item.itemId,
            fieldValueByName: {
              __typename: 'ProjectV2ItemFieldSingleSelectValue' as const,
              name: item.statusName,
            },
            content: {
              __typename: 'Issue' as const,
              number: item.issueNumber,
              title: item.issueTitle,
              body: item.issueBody,
              url: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${item.issueNumber}`,
              repository: {
                name: TEST_REPO_NAME,
                owner: { login: TEST_REPO_OWNER },
                defaultBranchRef: { name: 'main' },
              },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

describe('assertWorkflowArtifacts', () => {
  it('verifies deterministic fake-agent artifacts against GitHub responses', async () => {
    const config = createTestConfig();
    const seededIssue = createSeededIssue();
    const selectedIssue = createSelectedIssue(seededIssue.issueUrl);
    const workflowResult = createWorkflowResult();
    const { deps } = createGitHubDepsStub({
      [`REST GET /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls/12`]: {
        number: 12,
        html_url: workflowResult.pullRequestUrl,
        title: '#77: Seeded issue',
        body: [
          `Closes https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
          '',
          '> Generated by the Night Shift Implement phase.',
          '',
          '## Summary',
          `Deterministic fake e2e change for ${TEST_RUN_ID}.`,
          '',
          '## Follow-ups',
          `- Run marker: ${TEST_RUN_ID}`,
        ].join('\n'),
        state: 'open',
        head: { ref: workflowResult.branchName, sha: 'abc123' },
      },
      [`REST GET /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits/abc123`]: {
        commit: { message: `test: fake e2e change for ${TEST_RUN_ID}` },
      },
      [`REST GET /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77/comments`]: [
        {
          body: [
            buildNightShiftMarker('implement:summary'),
            '## Implement summary for #77',
            '- Change: `openspec/changes/77-seeded-issue`',
            `- Summary: Deterministic fake e2e change for ${TEST_RUN_ID}.`,
            `- Follow-ups: Run marker: ${TEST_RUN_ID}`,
            '- Quality gate: make check passed',
          ].join('\n'),
        },
        {
          body: [
            buildNightShiftMarker('review:summary'),
            '## Review summary for #77',
            '- Change: `openspec/changes/77-seeded-issue`',
            `- Pull request: https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pull/12`,
            '- Verdict: ready-to-merge',
            '- Iteration: 2',
            `- Summary: Review looks good for ${TEST_RUN_ID} after one rerun.`,
            `- Findings: warning: Run marker ${TEST_RUN_ID} is embedded in the fake E2E artifact for traceability. (${FAKE_AGENT_FILE_PATH}:3)`,
          ].join('\n'),
        },
      ],
      [`REST GET /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/contents/${FAKE_AGENT_FILE_PATH}?ref=${encodeURIComponent(workflowResult.branchName)}`]: {
        content: Buffer.from(buildFakeAgentFileText(TEST_RUN_ID)).toString('base64'),
        encoding: 'base64',
      },
    });

    await assert.doesNotReject(() =>
      assertWorkflowArtifacts(deps, config, seededIssue, selectedIssue, workflowResult),
    );
  });
});

describe('seedIssueInProject', () => {
  it('creates an issue, adds it to the project, and moves it to Ready', async () => {
    const config = createTestConfig();
    const { deps, calls } = createGitHubDepsStub({
      [`REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`]: {
        number: 77,
        html_url: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
        node_id: 'I_issue_77',
      },
      GRAPHQL_UserProjectIssueSelection: createProjectSelectionResponse(),
      GRAPHQL_AddProjectItem: {
        addProjectV2ItemById: {
          item: {
            id: 'PVT_item',
          },
        },
      },
      GRAPHQL_MoveProjectItemStatus: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: 'PVT_item' },
        },
      },
    });

    const seededIssue = await seedIssueInProject(
      deps,
      config,
      TEST_RUN_ID,
      `[e2e] orchestrator live test ${TEST_RUN_ID}`,
      `E2E_RUN_MARKER: ${TEST_RUN_ID}`,
    );

    assert.deepStrictEqual(seededIssue, createSeededIssue());
    assert.deepStrictEqual(calls, [
      `REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`,
      'GRAPHQL UserProjectIssueSelection',
      'GRAPHQL AddProjectItem',
      'GRAPHQL MoveProjectItemStatus',
    ]);
  });

  it('normalizes missing canonical project statuses before seeding the issue', async () => {
    const config = createTestConfig();
    const { deps, calls } = createGitHubDepsStub({
      [`REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`]: {
        number: 77,
        html_url: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
        node_id: 'I_issue_77',
      },
      GRAPHQL_UserProjectIssueSelection: createProjectSelectionResponse({
        statusOptions: [
          { id: 'ready', name: 'Ready' },
          { id: 'in-progress', name: 'In progress' },
          { id: 'in-review', name: 'In review' },
        ],
      }),
      GRAPHQL_UpdateStatusField: {
        updateProjectV2Field: {
          projectV2Field: {
            id: 'PVT_field',
            options: [
              { id: 'backlog', name: 'Backlog' },
              { id: 'refinement', name: 'Refinement' },
              { id: 'refined', name: 'Refined' },
              { id: 'ready', name: 'Ready' },
              { id: 'in-progress', name: 'In progress' },
              { id: 'in-review', name: 'In review' },
              { id: 'ready-to-merge', name: 'Ready to merge' },
              { id: 'blocked', name: 'Blocked' },
            ],
          },
        },
      },
      GRAPHQL_AddProjectItem: {
        addProjectV2ItemById: {
          item: {
            id: 'PVT_item',
          },
        },
      },
      GRAPHQL_MoveProjectItemStatus: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: 'PVT_item' },
        },
      },
    });

    await seedIssueInProject(
      deps,
      config,
      TEST_RUN_ID,
      `[e2e] orchestrator live test ${TEST_RUN_ID}`,
      `E2E_RUN_MARKER: ${TEST_RUN_ID}`,
    );

    assert.deepStrictEqual(calls, [
      `REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`,
      'GRAPHQL UserProjectIssueSelection',
      'GRAPHQL UpdateStatusField',
      'GRAPHQL AddProjectItem',
      'GRAPHQL MoveProjectItemStatus',
    ]);
  });

  it('reuses the existing project item when GitHub reports the issue is already on the project', async () => {
    const config = createTestConfig();
    const { deps, calls } = createGitHubDepsStub({
      [`REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`]: {
        number: 77,
        html_url: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
        node_id: 'I_issue_77',
      },
      GRAPHQL_UserProjectIssueSelection: createProjectSelectionResponse(),
      GRAPHQL_AddProjectItem: rawResponse(200, JSON.stringify({ errors: [{ message: 'Content already exists in this project' }] })),
      GRAPHQL_ExistingProjectItem: {
        node: {
          __typename: 'Issue',
          projectItems: {
            nodes: [{ id: 'PVT_item', project: { id: 'PVT_project' } }],
          },
        },
      },
      GRAPHQL_MoveProjectItemStatus: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: 'PVT_item' },
        },
      },
    });

    const seededIssue = await seedIssueInProject(
      deps,
      config,
      TEST_RUN_ID,
      `[e2e] orchestrator live test ${TEST_RUN_ID}`,
      `E2E_RUN_MARKER: ${TEST_RUN_ID}`,
    );

    assert.deepStrictEqual(seededIssue, createSeededIssue());
    assert.deepStrictEqual(calls, [
      `REST POST /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`,
      'GRAPHQL UserProjectIssueSelection',
      'GRAPHQL AddProjectItem',
      'GRAPHQL ExistingProjectItem',
      'GRAPHQL MoveProjectItemStatus',
    ]);
  });
});

describe('getProjectItemStatusName', () => {
  it('returns the current single-select status name for a project item', async () => {
    const { deps } = createGitHubDepsStub({
      GRAPHQL_ProjectItemStatus: {
        node: {
          __typename: 'ProjectV2Item',
          fieldValueByName: {
            __typename: 'ProjectV2ItemFieldSingleSelectValue',
            name: 'In review',
          },
        },
      },
    });

    const status = await getProjectItemStatusName(deps, 'PVT_item');
    assert.strictEqual(status, 'In review');
  });
});

describe('assertSeededIssueWillBeSelected', () => {
  it('accepts the seeded issue when the project selection query resolves to that issue', async () => {
    const config = createTestConfig();
    const { deps } = createGitHubDepsStub({
      GRAPHQL_UserProjectIssueSelection: createProjectSelectionResponse({
        itemId: 'PVT_item',
        statusName: 'Ready',
        issueNumber: 77,
        issueTitle: 'Seeded issue',
        issueBody: 'Create a deterministic change',
      }),
    });

    const selectedIssue = await assertSeededIssueWillBeSelected(deps, config, 77);

    assert.strictEqual(selectedIssue.issueNumber, 77);
    assert.strictEqual(selectedIssue.repoOwner, TEST_REPO_OWNER);
    assert.strictEqual(selectedIssue.repoName, TEST_REPO_NAME);
  });

  it('retries when GitHub project selection is briefly stale after seeding', async () => {
    const config = createTestConfig();
    const { deps, calls } = createGitHubDepsStub({
      GRAPHQL_UserProjectIssueSelection: sequenceOf(
        createProjectSelectionResponse({
          itemId: 'PVTI_backlog',
          statusName: 'Backlog',
          issueNumber: 1,
          issueTitle: 'Other issue',
          issueBody: 'Not ready',
        }),
        createProjectSelectionResponse({
          itemId: 'PVT_item',
          statusName: 'Ready',
          issueNumber: 77,
          issueTitle: 'Seeded issue',
          issueBody: 'Create a deterministic change',
        }),
      ),
    });

    const selectedIssue = await assertSeededIssueWillBeSelected(deps, config, 77, {
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    assert.strictEqual(selectedIssue.issueNumber, 77);
    assert.deepStrictEqual(calls, ['GRAPHQL UserProjectIssueSelection', 'GRAPHQL UserProjectIssueSelection']);
  });
});

describe('cleanupRunArtifacts', () => {
  it('closes and deletes the created GitHub artifacts when a workflow result exists', async () => {
    const config = createTestConfig();
    const seededIssue = createSeededIssue();
    const selectedIssue = createSelectedIssue(seededIssue.issueUrl);
    const { deps, calls } = createGitHubDepsStub({
      [`REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls/12`]: {},
      [`REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`]: {},
      GRAPHQL_DeleteProjectItem: {
        deleteProjectV2Item: { deletedItemId: 'PVT_item' },
      },
      [`REST DELETE /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/orchestrator-e2e-run-123%2Fissue-77`]: {},
    });

    const report = await cleanupRunArtifacts(
      deps,
      config,
      seededIssue,
      selectedIssue,
      'orchestrator-e2e-run-123',
      createWorkflowResult({ filePath: FAKE_AGENT_FILE_PATH }),
    );

    assert.deepStrictEqual(report, {
      attempted: ['closePullRequest', 'closeIssue', 'deleteProjectItem', 'deleteBranch'],
      failures: [],
    });
    assert.deepStrictEqual(calls, [
      `REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls/12`,
      `REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`,
      'GRAPHQL DeleteProjectItem',
      `REST DELETE /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/orchestrator-e2e-run-123%2Fissue-77`,
    ]);
  });

  it('treats an empty 204 branch-delete response as successful cleanup', async () => {
    const config = createTestConfig();
    const seededIssue = createSeededIssue();
    const selectedIssue = createSelectedIssue(seededIssue.issueUrl);
    const { deps } = createGitHubDepsStub({
      [`REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls/12`]: {},
      [`REST PATCH /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/77`]: {},
      GRAPHQL_DeleteProjectItem: {
        deleteProjectV2Item: { deletedItemId: 'PVT_item' },
      },
      [`REST DELETE /repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/orchestrator-e2e-run-123%2Fissue-77`]: rawResponse(204, ''),
    });

    const report = await cleanupRunArtifacts(
      deps,
      config,
      seededIssue,
      selectedIssue,
      'orchestrator-e2e-run-123',
      createWorkflowResult({ filePath: FAKE_AGENT_FILE_PATH }),
    );

    assert.deepStrictEqual(report, {
      attempted: ['closePullRequest', 'closeIssue', 'deleteProjectItem', 'deleteBranch'],
      failures: [],
    });
  });
});

function createGitHubDepsStub(responses: Record<string, unknown | StubSequence>): { deps: GitHubClientDeps; calls: string[] } {
  const calls: string[] = [];

  return {
    deps: {
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = typeof init?.method === 'string' ? init.method : 'GET';
        const requestUrl = new URL(url);
        const pathname = requestUrl.pathname;
        const search = requestUrl.search;

        if (pathname === '/graphql') {
          const bodyText = typeof init?.body === 'string' ? init.body : '{}';
          const payload = JSON.parse(bodyText) as { query?: string };
          const operationName = payload.query?.match(/(query|mutation)\s+([A-Za-z0-9_]+)/)?.[2] ?? 'UnknownOperation';
          const key = `GRAPHQL_${operationName}`;
          calls.push(`GRAPHQL ${operationName}`);

          if (!(key in responses)) {
            return createJsonFetchResponse({ errors: [{ message: `Unexpected GraphQL operation: ${operationName}` }] }, {
              status: 200,
            });
          }

          const responseBody = takeStubResponse(responses, key);
          if (isRawResponseStub(responseBody)) {
            return createRawFetchResponse(responseBody);
          }

          return createJsonFetchResponse({ data: responseBody }, {
            status: 200,
          });
        }

        const key = `REST ${method.toUpperCase()} ${pathname}${search}`;
        calls.push(key);
        if (!(key in responses)) {
          return createJsonFetchResponse({ message: `Unexpected path: ${key}` }, {
            status: 404,
            statusText: 'Not Found',
          });
        }

        const responseBody = takeStubResponse(responses, key);
        if (isRawResponseStub(responseBody)) {
          return createRawFetchResponse(responseBody);
        }

        return createJsonFetchResponse(responseBody, {
          status: 200,
        });
      },
      getGitHubToken: () => 'test-token',
    },
    calls,
  };
}

interface StubSequence {
  __sequence: unknown[];
}

interface RawResponseStub {
  __raw: {
    status: number;
    body?: string;
    statusText?: string;
  };
}

function takeStubResponse(responses: Record<string, unknown | StubSequence | RawResponseStub>, key: string): unknown {
  const response = responses[key];
  if (!isStubSequence(response)) {
    return response;
  }
  if (response.__sequence.length === 0) {
    throw new Error(`No remaining stub responses for ${key}`);
  }
  return response.__sequence.shift();
}

function sequenceOf(...responses: unknown[]): StubSequence {
  return { __sequence: [...responses] };
}

function rawResponse(status: number, body?: string, statusText?: string): RawResponseStub {
  return { __raw: { status, body, statusText } };
}

function createJsonFetchResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function isStubSequence(response: unknown): response is StubSequence {
  return response !== null && typeof response === 'object' && '__sequence' in response;
}

function isRawResponseStub(response: unknown): response is RawResponseStub {
  return response !== null && typeof response === 'object' && '__raw' in response;
}

function createRawFetchResponse(response: RawResponseStub): Response {
  const { status, statusText, body } = response.__raw;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText ?? '',
    text: async () => body ?? '',
  } as Response;
}

function buildStatusField(options: Array<{ id: string; name: string }> = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'refinement', name: 'Refinement' },
  { id: 'refined', name: 'Refined' },
  { id: 'ready', name: 'Ready' },
  { id: 'in-progress', name: 'In progress' },
  { id: 'in-review', name: 'In review' },
  { id: 'ready-to-merge', name: 'Ready to merge' },
  { id: 'blocked', name: 'Blocked' },
]) {
  return {
    __typename: 'ProjectV2SingleSelectField' as const,
    id: 'PVT_field',
    name: 'Status',
    options,
  };
}