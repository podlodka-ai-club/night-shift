import { describe, it } from 'mocha';
import assert from 'assert';
import path from 'node:path';
import {
  activityRuntime,
  buildBranchName,
  buildDummyChangeContent,
  buildDummyFilePath,
  buildIssueComment,
  cleanupWorktree,
  commitAndPush,
  createWorktreeForIssueIfNeeded,
  getTopReadyIssue,
  openPullRequest,
  runAgent,
  runDummyAgent,
} from '../activities';
import type { CreatedPullRequest, SelectedProjectIssue, WorktreeContext } from '../shared';

const TEST_GITHUB_TOKEN = 'test-token';

describe('github activities', () => {
  it('selects the first ready issue from the project response', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const restoreFetch = mockFetchSequence([jsonResponse(buildProjectQueryResponse(selectedIssue))], fetchCalls);

    try {
      const issue = await withGitHubToken(() => getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 }));

      assert.deepStrictEqual(issue, selectedIssue);
      assert.strictEqual(fetchCalls.length, 1);
      assert.strictEqual(fetchCalls[0].url, 'https://api.github.com/graphql');
      assert.strictEqual(fetchCalls[0].init?.method, 'POST');
      assert.match(String(fetchCalls[0].init?.body), /owner: user\(login: \$login\)/);
      assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)).variables, {
        login: 'Mugenor',
        number: 1,
        itemsFirst: 100,
      });
    } finally {
      restoreFetch();
    }
  });

  it('falls back to an organization-owned project when the login is not a user', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const restoreFetch = mockFetchSequence(
      [
        jsonResponse({
          data: { owner: null },
          errors: [{ message: "Could not resolve to a User with the login of 'Mugenor'." }],
        }),
        jsonResponse(buildProjectQueryResponse(selectedIssue)),
      ],
      fetchCalls,
    );

    try {
      const issue = await withGitHubToken(() => getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 }));

      assert.deepStrictEqual(issue, selectedIssue);
      assert.strictEqual(fetchCalls.length, 2);
      assert.match(String(fetchCalls[0].init?.body), /owner: user\(login: \$login\)/);
      assert.match(String(fetchCalls[1].init?.body), /owner: organization\(login: \$login\)/);
    } finally {
      restoreFetch();
    }
  });

  it('creates a stable worktree context after local git preparation', async () => {
    const issue = buildSelectedIssue();
    const expectedWorktree = buildWorktreeContext(issue);
    const gitCalls: GitCall[] = [];
    const mkdirCalls: MkdirCall[] = [];
    const { repoRoot, worktreePath } = expectedWorktree;
    const restoreRuntime = mockActivityRuntime({
      access: async (targetPath: string) => {
        if (targetPath === repoRoot || targetPath === worktreePath) {
          throw createNotFoundError();
        }
      },
      mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      now: () => 123,
    });

    try {
      const worktree = await createWorktreeForIssueIfNeeded({ issue });

      assert.deepStrictEqual(worktree, expectedWorktree);

      assert.deepStrictEqual(gitCalls, [
        {
          cwd: '/tmp/orchestrator/Mugenor',
          args: ['clone', 'https://github.com/Mugenor/orchestrator-testing.git', repoRoot],
        },
        {
          cwd: repoRoot,
          args: ['check-ignore', '.worktrees'],
        },
        {
          cwd: repoRoot,
          args: ['checkout', '-B', 'main', 'origin/main'],
        },
        {
          cwd: repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', 'orchestrator/issue-7'],
        },
        {
          cwd: repoRoot,
          args: ['worktree', 'add', '-b', 'orchestrator/issue-7', worktreePath, 'origin/main'],
        },
      ]);
      assert.deepStrictEqual(mkdirCalls, [
        { path: '/tmp/orchestrator/Mugenor', options: { recursive: true } },
        { path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees', options: { recursive: true } },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('reuses an existing clone by fetching before creating the worktree', async () => {
    const issue = buildSelectedIssue();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          throw createNotFoundError();
        }
      },
      mkdir: async () => undefined,
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      now: () => 123,
    });

    try {
      await createWorktreeForIssueIfNeeded({ issue });

      assert.deepStrictEqual(gitCalls[0], {
        cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
        args: ['fetch', '--prune', 'origin'],
      });
    } finally {
      restoreRuntime();
    }
  });

  it('returns the existing worktree context when the issue worktree is already present', async () => {
    const issue = buildSelectedIssue();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          return undefined;
        }
        throw createNotFoundError();
      },
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      now: () => 123,
    });

    try {
      const worktree = await createWorktreeForIssueIfNeeded({ issue });

      assert.deepStrictEqual(worktree, buildWorktreeContext(issue));
      assert.deepStrictEqual(gitCalls, []);
    } finally {
      restoreRuntime();
    }
  });

  it('adds .worktrees to the local info exclude when it is not already ignored', async () => {
    const issue = buildSelectedIssue();
    const gitCalls: GitCall[] = [];
    const appendCalls: AppendCall[] = [];
    const mkdirCalls: MkdirCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      access: async (targetPath: string) => {
        if (targetPath.endsWith('/.worktrees/orchestrator/issue-7')) {
          throw createNotFoundError();
        }
      },
      mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
      appendFile: async (targetPath, data, encoding) => {
        appendCalls.push({ path: targetPath, data, encoding });
      },
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      now: () => 123,
    });

    try {
      const worktree = await createWorktreeForIssueIfNeeded({ issue });

      assert.deepStrictEqual(worktree, buildWorktreeContext(issue));
      assert.deepStrictEqual(gitCalls, [
        {
          cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
          args: ['fetch', '--prune', 'origin'],
        },
        {
          cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
          args: ['check-ignore', '.worktrees'],
        },
        {
          cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
          args: ['checkout', '-B', 'main', 'origin/main'],
        },
        {
          cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
          args: ['ls-remote', '--exit-code', '--heads', 'origin', 'orchestrator/issue-7'],
        },
        {
          cwd: '/tmp/orchestrator/Mugenor/orchestrator-testing',
          args: [
            'worktree',
            'add',
            '-b',
            'orchestrator/issue-7',
            '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7',
            'origin/main',
          ],
        },
      ]);
      assert.deepStrictEqual(mkdirCalls, [
        {
          path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.git/info',
          options: { recursive: true },
        },
        {
          path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees',
          options: { recursive: true },
        },
      ]);
      assert.deepStrictEqual(appendCalls, [
        {
          path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.git/info/exclude',
          data: '.worktrees/\n',
          encoding: 'utf8',
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('recreates the local worktree from the remote issue branch when it already exists', async () => {
    const issue = buildSelectedIssue();
    const worktree = buildWorktreeContext(issue);
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      access: async (targetPath: string) => {
        if (targetPath === worktree.worktreePath) {
          throw createNotFoundError();
        }
      },
      mkdir: async () => undefined,
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'check-ignore') {
          return { stdout: '.worktrees\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: `abc\t${worktree.branchName}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      now: () => 123,
    });

    try {
      await createWorktreeForIssueIfNeeded({ issue });

      assert.deepStrictEqual(gitCalls, [
        {
          cwd: worktree.repoRoot,
          args: ['fetch', '--prune', 'origin'],
        },
        {
          cwd: worktree.repoRoot,
          args: ['check-ignore', '.worktrees'],
        },
        {
          cwd: worktree.repoRoot,
          args: ['checkout', '-B', 'main', 'origin/main'],
        },
        {
          cwd: worktree.repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName],
        },
        {
          cwd: worktree.repoRoot,
          args: [
            'worktree',
            'add',
            '-B',
            worktree.branchName,
            worktree.worktreePath,
            `origin/${worktree.branchName}`,
          ],
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('invokes codex in the worktree during runAgent', async () => {
    const worktree = buildWorktreeContext();
    const commandCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (file, args, options) => {
        commandCalls.push({ args: [file, ...args], cwd: options?.cwd });
        return { stdout: 'done', stderr: '', exitCode: 0 };
      },
    });

    try {
      await runAgent({ worktree });

      assert.deepStrictEqual(commandCalls, [
        {
          cwd: worktree.worktreePath,
          args: [
            'codex',
            'exec',
            '--full-auto',
            '--model',
            'gpt-5.3-codex',
            '--config',
            'model_reasoning_effort="low"',
            [
              'Implement the task in this repository.',
              '',
              'Task description:',
              worktree.taskDescription,
            ].join('\n'),
          ],
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('preserves the dummy file writer in runDummyAgent', async () => {
    const worktree = buildWorktreeContext();
    const mkdirCalls: MkdirCall[] = [];
    const writeCalls: WriteCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      mkdir: async (targetPath, options) => {
        mkdirCalls.push({ path: String(targetPath), options });
        return undefined;
      },
      writeFile: async (targetPath, data, encoding) => {
        writeCalls.push({ path: String(targetPath), data, encoding });
      },
    });

    try {
      await runDummyAgent({ worktree });

      assert.deepStrictEqual(mkdirCalls, [
        {
          path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7/orchestrator-runs',
          options: { recursive: true },
        },
      ]);
      assert.deepStrictEqual(writeCalls, [
        {
          path: '/tmp/orchestrator/Mugenor/orchestrator-testing/.worktrees/orchestrator/issue-7/orchestrator-runs/issue-7.md',
          data: buildDummyChangeContent(7, 'Create a dummy PR', '1970-01-01T00:00:00.123Z'),
          encoding: 'utf8',
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('stages, commits, and pushes the worktree changes', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      await commitAndPush({ worktree });

      assert.deepStrictEqual(gitCalls, [
        {
          cwd: worktree.worktreePath,
          args: ['add', '--all'],
        },
        {
          cwd: worktree.worktreePath,
          args: ['diff', '--cached', '--quiet', '--exit-code'],
        },
        {
          cwd: worktree.worktreePath,
          args: ['commit', '-m', `Add dummy change for issue #${worktree.issueNumber}`],
        },
        {
          cwd: worktree.worktreePath,
          args: ['push', '-u', 'origin', worktree.branchName],
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('skips commit but still pushes when commitAndPush is retried with no staged changes', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'commit') {
          throw new Error('commit should be skipped when nothing is staged');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      await commitAndPush({ worktree });

      assert.deepStrictEqual(gitCalls, [
        {
          cwd: worktree.worktreePath,
          args: ['add', '--all'],
        },
        {
          cwd: worktree.worktreePath,
          args: ['diff', '--cached', '--quiet', '--exit-code'],
        },
        {
          cwd: worktree.worktreePath,
          args: ['push', '-u', 'origin', worktree.branchName],
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('opens the pull request using the stable issue branch', async () => {
    const worktree = buildWorktreeContext();
    const pullRequestUrl = buildPullRequestUrl(worktree);
    const fetchCalls: FetchCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });

        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([]);
        }

        return jsonResponse({ number: 42, html_url: pullRequestUrl });
      },
    });

    try {
      const pullRequest = await withGitHubToken(() => openPullRequest({ worktree }));

      assert.deepStrictEqual(pullRequest, buildExpectedCreatedPullRequest(worktree));
      assert.strictEqual(fetchCalls.length, 2);
      assert.deepStrictEqual(
        { url: fetchCalls[0].url, method: fetchCalls[0].init?.method ?? 'GET' },
        {
          url: buildOpenPullRequestLookupUrl(worktree),
          method: 'GET',
        },
      );
      assert.deepStrictEqual(
        { url: fetchCalls[1].url, method: fetchCalls[1].init?.method ?? 'GET' },
        {
          url: buildPullRequestsApiUrl(worktree),
          method: 'POST',
        },
      );
      assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
        title: `chore: dummy change for #${worktree.issueNumber}`,
        head: worktree.branchName,
        base: worktree.defaultBranch,
        body: `Automated dummy change for ${worktree.issueUrl}`,
      });
    } finally {
      restoreRuntime();
    }
  });

  it('reuses an existing open pull request for the issue branch', async () => {
    const worktree = buildWorktreeContext();
    const pullRequestUrl = buildPullRequestUrl(worktree);
    const fetchCalls: FetchCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return jsonResponse([{ number: 42, html_url: pullRequestUrl }]);
      },
    });

    try {
      const pullRequest = await withGitHubToken(() => openPullRequest({ worktree }));

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
    } finally {
      restoreRuntime();
    }
  });

  it('recovers from a duplicate-create PR race by re-querying the branch PR', async () => {
    const worktree = buildWorktreeContext();
    const pullRequestUrl = buildPullRequestUrl(worktree);
    const fetchCalls: FetchCall[] = [];
    const lookupResponses = [jsonResponse([]), jsonResponse([{ number: 42, html_url: pullRequestUrl }])];
    const restoreRuntime = mockActivityRuntime({
      fetch: async (input, init) => {
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
      },
    });

    try {
      const pullRequest = await withGitHubToken(() => openPullRequest({ worktree }));

      assert.deepStrictEqual(pullRequest, buildExpectedCreatedPullRequest(worktree));
      assert.deepStrictEqual(
        fetchCalls.map((call) => ({ url: call.url, method: call.init?.method ?? 'GET' })),
        [
          { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
          { url: buildPullRequestsApiUrl(worktree), method: 'POST' },
          { url: buildOpenPullRequestLookupUrl(worktree), method: 'GET' },
        ],
      );
    } finally {
      restoreRuntime();
    }
  });

  it('removes the local worktree and branch during cleanup', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      await cleanupWorktree({ worktree });

      assert.deepStrictEqual(gitCalls, [
        {
          cwd: worktree.repoRoot,
          args: ['worktree', 'remove', '--force', worktree.worktreePath],
        },
        {
          cwd: worktree.repoRoot,
          args: ['branch', '-D', worktree.branchName],
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('builds deterministic helper values', () => {
    assert.strictEqual(buildBranchName(9, 'auto'), 'auto/issue-9');
    assert.strictEqual(buildDummyFilePath(9, 'runs'), 'runs/issue-9.md');
    assert.strictEqual(
      buildDummyChangeContent(9, 'Ship Dummy Automation!', '2026-04-26T00:00:00.000Z'),
      ['# Orchestrator Dummy Change', '', '- Issue: #9', '- Title: Ship Dummy Automation!', '- Generated at: 2026-04-26T00:00:00.000Z'].join('\n'),
    );
    assert.strictEqual(
      buildIssueComment('https://github.com/Mugenor/orchestrator-testing/pull/42'),
      'Opened a pull request for this issue: https://github.com/Mugenor/orchestrator-testing/pull/42',
    );
  });

  it('closes stdin for child commands in the default command runner', async () => {
    const orchestratorRoot = path.resolve(__dirname, '..', '..');
    const result = await activityRuntime.execFile(
      'node',
      [
        '-e',
        [
          "process.stdin.once('end', () => {",
          "  console.log('stdin-closed');",
          '  process.exit(0);',
          '});',
          "process.stdin.resume();",
          'setTimeout(() => {',
          "  console.error('stdin-still-open');",
          '  process.exit(7);',
          '}, 100);',
        ].join(' '),
      ],
      { cwd: orchestratorRoot },
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /stdin-closed/);
  });
});

function buildSelectedIssue(): SelectedProjectIssue {
  return {
    projectId: 'project-1',
    projectItemId: 'item-1',
    statusFieldId: 'status-field',
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
    issueNumber: 7,
    issueTitle: 'Create a dummy PR',
    taskDescription: 'Implement the requested repository change for issue 7.',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/7',
    repoOwner: 'Mugenor',
    repoName: 'orchestrator-testing',
    defaultBranch: 'main',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
  };
}

function buildWorktreeContext(issue = buildSelectedIssue()): WorktreeContext {
  const branchName = buildBranchName(issue.issueNumber);
  const filePath = buildDummyFilePath(issue.issueNumber);
  const repoRoot = `/tmp/orchestrator/${issue.repoOwner}/${issue.repoName}`;

  return {
    issueNumber: issue.issueNumber,
    issueTitle: issue.issueTitle,
    taskDescription: issue.taskDescription,
    issueUrl: issue.issueUrl,
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    defaultBranch: issue.defaultBranch,
    branchName,
    filePath,
    generatedAt: '1970-01-01T00:00:00.123Z',
    repoRoot,
    worktreePath: `${repoRoot}/.worktrees/${branchName}`,
  };
}

function buildProjectQueryResponse(issue: SelectedProjectIssue): unknown {
  return {
    data: {
      owner: {
        projectV2: {
          id: issue.projectId,
          fields: {
            nodes: [
              {
                __typename: 'ProjectV2SingleSelectField',
                id: issue.statusFieldId,
                name: 'Status',
                options: [
                  { id: 'ready-option', name: issue.readyStatusName },
                  { id: issue.inProgressOptionId, name: 'In progress' },
                  { id: issue.inReviewOptionId, name: issue.inReviewStatusName },
                ],
              },
            ],
          },
          items: {
            nodes: [
              {
                id: issue.projectItemId,
                fieldValueByName: {
                  __typename: 'ProjectV2ItemFieldSingleSelectValue',
                  name: issue.readyStatusName,
                },
                content: {
                  __typename: 'Issue',
                  number: issue.issueNumber,
                  title: issue.issueTitle,
                  body: issue.taskDescription,
                  url: issue.issueUrl,
                  repository: {
                    name: issue.repoName,
                    owner: { login: issue.repoOwner },
                    defaultBranchRef: { name: issue.defaultBranch },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

function buildPullRequestsApiUrl(worktree: WorktreeContext): string {
  return `https://api.github.com/repos/${worktree.repoOwner}/${worktree.repoName}/pulls`;
}

function buildOpenPullRequestLookupUrl(worktree: WorktreeContext): string {
  const query = new URLSearchParams({
    head: `${worktree.repoOwner}:${worktree.branchName}`,
    state: 'open',
    base: worktree.defaultBranch,
  });

  return `${buildPullRequestsApiUrl(worktree)}?${query.toString()}`;
}

function buildPullRequestUrl(worktree: WorktreeContext, pullRequestNumber = 42): string {
  return `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/${pullRequestNumber}`;
}

function buildExpectedCreatedPullRequest(
  worktree: WorktreeContext,
  pullRequestNumber = 42,
): CreatedPullRequest {
  return {
    branchName: worktree.branchName,
    filePath: worktree.filePath,
    pullRequestNumber,
    pullRequestUrl: buildPullRequestUrl(worktree, pullRequestNumber),
  };
}

async function withGitHubToken<T>(callback: () => Promise<T>): Promise<T> {
  process.env.GITHUB_TOKEN = TEST_GITHUB_TOKEN;

  try {
    return await callback();
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchSequence(responses: Response[], calls: FetchCall[]): () => void {
  const originalFetch = activityRuntime.fetch;
  activityRuntime.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const nextResponse = responses.shift();
    if (!nextResponse) {
      throw new Error('Unexpected fetch call in test.');
    }
    return nextResponse;
  };

  return () => {
    activityRuntime.fetch = originalFetch;
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface GitCall {
  cwd?: string;
  args: string[];
}

interface MkdirCall {
  path: string;
  options: unknown;
}

interface AppendCall {
  path: string;
  data: string;
  encoding: BufferEncoding;
}

interface WriteCall {
  path: string;
  data: string;
  encoding: BufferEncoding;
}

function mockActivityRuntime(overrides: Partial<typeof activityRuntime>): () => void {
  const originalRuntime = { ...activityRuntime };
  Object.assign(activityRuntime, overrides);

  return () => {
    Object.assign(activityRuntime, originalRuntime);
  };
}

function createNotFoundError(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}