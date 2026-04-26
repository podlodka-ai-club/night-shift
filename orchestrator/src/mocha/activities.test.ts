import { describe, it } from 'mocha';
import assert from 'assert';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
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
  runAgentLegacy,
  runAgentSequence,
  runDummyAgent,
} from '../activities';
import { CHANGE_METADATA_OUTPUT_KEY, type AgentStep, type CreatedPullRequest, type SelectedProjectIssue, type WorktreeContext } from '../shared';

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
        itemsAfter: null,
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
      assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)).variables, {
        login: 'Mugenor',
        number: 1,
        itemsFirst: 100,
        itemsAfter: null,
      });
    } finally {
      restoreFetch();
    }
  });

  it('paginates project items until it finds a Ready issue on a later page', async () => {
    const selectedIssue = buildSelectedIssue();
    const fetchCalls: FetchCall[] = [];
    const restoreFetch = mockFetchSequence(
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
    );

    try {
      const issue = await withGitHubToken(() => getTopReadyIssue({ projectOwner: 'Mugenor', projectNumber: 1 }));

      assert.deepStrictEqual(issue, selectedIssue);
      assert.strictEqual(fetchCalls.length, 2);
      assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)).variables, {
        login: 'Mugenor',
        number: 1,
        itemsFirst: 100,
        itemsAfter: null,
      });
      assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)).variables, {
        login: 'Mugenor',
        number: 1,
        itemsFirst: 100,
        itemsAfter: 'cursor-1',
      });
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

  it('invokes codex in the worktree during runAgentLegacy', async () => {
    const worktree = buildWorktreeContext();
    const commandCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (file, args, options) => {
        commandCalls.push({ args: [file, ...args], cwd: options?.cwd });
        return { stdout: 'done', stderr: '', exitCode: 0 };
      },
    });

    try {
      await runAgentLegacy({ worktree });

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

  it('passes the Temporal cancellation signal to the CLI codex path', async () => {
    const worktree = buildWorktreeContext();
    const abortController = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const restoreContext = mockActivityContext({ cancellationSignal: abortController.signal });
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, _args, options) => {
        signals.push(options?.signal);
        return { stdout: 'done', stderr: '', exitCode: 0 };
      },
    });

    try {
      await runAgentLegacy({ worktree });

      assert.deepStrictEqual(signals, [abortController.signal]);
    } finally {
      restoreRuntime();
      restoreContext();
    }
  });

  it('runs a same-thread structured agent sequence and returns parsed outputs', async () => {
    const worktree = buildWorktreeContext();
    const heartbeatCalls: unknown[] = [];
    const runCalls: Array<{ prompt: string; outputSchema?: unknown }> = [];
    const thread = {
      id: 'thread-123',
      run: async (prompt: string, options?: { outputSchema?: unknown }) => {
        runCalls.push({ prompt, outputSchema: options?.outputSchema });
        if (runCalls.length === 1) {
          return { items: [], finalResponse: 'Implemented the requested change.', usage: null };
        }
        return {
          items: [],
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          usage: null,
        };
      },
    };
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => thread,
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.strictEqual(runCalls.length, 2);
      assert.deepStrictEqual(runCalls[0], {
        prompt: buildTaskImplementationPrompt(worktree.taskDescription),
        outputSchema: undefined,
      });
      assert.strictEqual(runCalls[1].prompt, buildChangeMetadataPrompt());
      assert.strictEqual(typeof runCalls[1].outputSchema, 'object');
      assert.strictEqual((runCalls[1].outputSchema as { type?: string })?.type, 'object');
      assert.deepStrictEqual(result, {
        threadId: 'thread-123',
        completedStepIds: ['edit', 'change-metadata'],
        outputs: {
          changeMetadata: buildGeneratedChangeMetadata(),
        },
        finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
      });
      assert.deepStrictEqual(heartbeatCalls, [
        {
          threadId: 'thread-123',
          completedStepIds: [],
          outputs: {},
        },
        {
          threadId: 'thread-123',
          completedStepIds: [],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
          pendingStep: {
            stepId: 'edit',
            finalResponse: 'Implemented the requested change.',
          },
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          pendingStep: {
            stepId: 'change-metadata',
            finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
            output: {
              resultKey: CHANGE_METADATA_OUTPUT_KEY,
              parsedOutput: buildGeneratedChangeMetadata(),
            },
          },
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit', 'change-metadata'],
          outputs: {
            changeMetadata: buildGeneratedChangeMetadata(),
          },
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('repairs a structured step when the first response is invalid', async () => {
    const worktree = buildWorktreeContext();
    const runCalls: string[] = [];
    const thread = {
      id: 'thread-123',
      run: async (prompt: string) => {
        runCalls.push(prompt);
        if (runCalls.length === 1) {
          return { items: [], finalResponse: 'Implemented the requested change.', usage: null };
        }
        if (runCalls.length === 2) {
          return { items: [], finalResponse: '{"commitMessage":42}', usage: null };
        }

        return {
          items: [],
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          usage: null,
        };
      },
    };
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => thread,
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
    });

    try {
      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.strictEqual(runCalls.length, 3);
      assert.match(runCalls[2], /previous response did not satisfy the required structured output schema/i);
      assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
    } finally {
      restoreRuntime();
    }
  });

  it('fails instead of silently dropping structured output when repair also fails', async () => {
    const worktree = buildWorktreeContext();
    const heartbeatCalls: unknown[] = [];
    let runCount = 0;
    const thread = {
      id: 'thread-123',
      run: async (_prompt: string) => {
        runCount += 1;
        if (runCount === 1) {
          return { items: [], finalResponse: 'Implemented the requested change.', usage: null };
        }

        return { items: [], finalResponse: '{"commitMessage":42}', usage: null };
      },
    };
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => thread,
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      await assert.rejects(() => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }), /did not satisfy schema/);
      assert.deepStrictEqual(heartbeatCalls, [
        {
          threadId: 'thread-123',
          completedStepIds: [],
          outputs: {},
        },
        {
          threadId: 'thread-123',
          completedStepIds: [],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
          pendingStep: {
            stepId: 'edit',
            finalResponse: 'Implemented the requested change.',
          },
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('resumes a structured agent sequence from heartbeat checkpoint details', async () => {
    const worktree = buildWorktreeContext();
    const runCalls: string[] = [];
    const resumeCalls: Array<{ worktreePath: string; threadId: string }> = [];
    const thread = {
      id: 'thread-123',
      run: async (prompt: string) => {
        runCalls.push(prompt);
        return {
          items: [],
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          usage: null,
        };
      },
    };
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => {
        throw new Error('create should not be used when a checkpoint exists');
      },
      resumeCodexThread: (worktreePath: string, threadId: string) => {
        resumeCalls.push({ worktreePath, threadId });
        return thread;
      },
      getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
      }),
      heartbeat: () => undefined,
    });

    try {
      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.deepStrictEqual(resumeCalls, [{ worktreePath: worktree.worktreePath, threadId: 'thread-123' }]);
      assert.deepStrictEqual(runCalls, [buildChangeMetadataPrompt()]);
      assert.deepStrictEqual(result.completedStepIds, ['edit', 'change-metadata']);
      assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
    } finally {
      restoreRuntime();
    }
  });

  it('finalizes a pending structured-step completion from heartbeat details without rerunning Codex', async () => {
    const worktree = buildWorktreeContext();
    const resumeCalls: Array<{ worktreePath: string; threadId: string }> = [];
    const heartbeatCalls: unknown[] = [];
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => {
        throw new Error('create should not be used when a pending structured step is checkpointed');
      },
      resumeCodexThread: (worktreePath: string, threadId: string) => {
        resumeCalls.push({ worktreePath, threadId });
        throw new Error('resume should not be used when the pending checkpoint already completes the sequence');
      },
      getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
        pendingStep: {
          stepId: 'change-metadata',
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
          output: {
            resultKey: CHANGE_METADATA_OUTPUT_KEY,
            parsedOutput: buildGeneratedChangeMetadata(),
          },
        },
      }),
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.deepStrictEqual(resumeCalls, []);
      assert.deepStrictEqual(result, {
        threadId: 'thread-123',
        completedStepIds: ['edit', 'change-metadata'],
        outputs: {
          changeMetadata: buildGeneratedChangeMetadata(),
        },
        finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
      });
      assert.deepStrictEqual(heartbeatCalls, [
        {
          threadId: 'thread-123',
          completedStepIds: ['edit', 'change-metadata'],
          outputs: {
            changeMetadata: buildGeneratedChangeMetadata(),
          },
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('finalizes a legacy pendingStructuredStep checkpoint without rerunning Codex', async () => {
    const worktree = buildWorktreeContext();
    const resumeCalls: Array<{ worktreePath: string; threadId: string }> = [];
    const heartbeatCalls: unknown[] = [];
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => {
        throw new Error('create should not be used when a legacy pending structured step is checkpointed');
      },
      resumeCodexThread: (worktreePath: string, threadId: string) => {
        resumeCalls.push({ worktreePath, threadId });
        throw new Error('resume should not be used when the legacy checkpoint already completes the sequence');
      },
      getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
        pendingStructuredStep: {
          stepId: 'change-metadata',
          resultKey: CHANGE_METADATA_OUTPUT_KEY,
          parsedOutput: buildGeneratedChangeMetadata(),
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
        },
      }),
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.deepStrictEqual(resumeCalls, []);
      assert.deepStrictEqual(result, {
        threadId: 'thread-123',
        completedStepIds: ['edit', 'change-metadata'],
        outputs: {
          changeMetadata: buildGeneratedChangeMetadata(),
        },
        finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
      });
      assert.deepStrictEqual(heartbeatCalls, [
        {
          threadId: 'thread-123',
          completedStepIds: ['edit', 'change-metadata'],
          outputs: {
            changeMetadata: buildGeneratedChangeMetadata(),
          },
          finalResponse: JSON.stringify(buildGeneratedChangeMetadata()),
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('resumes from the recorded checkpoint after a later step fails', async () => {
    const worktree = buildWorktreeContext();
    const runCalls: string[] = [];
    let phase: 'initial' | 'retry' = 'initial';
    let checkpointDetails: unknown;
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: 'thread-123',
        run: async (prompt: string) => {
          runCalls.push(`initial:${prompt}`);
          if (prompt === buildTaskImplementationPrompt(worktree.taskDescription)) {
            return { finalResponse: 'Implemented the requested change.' };
          }

          throw new Error('second step failed');
        },
      }),
      resumeCodexThread: (_worktreePath: string, threadId: string) => ({
        id: threadId,
        run: async (prompt: string) => {
          runCalls.push(`retry:${prompt}`);
          return { finalResponse: JSON.stringify(buildGeneratedChangeMetadata()) };
        },
      }),
      getHeartbeatDetails: () => (phase === 'retry' ? checkpointDetails : undefined),
      heartbeat: (details: unknown) => {
        checkpointDetails = details;
      },
    });

    try {
      await assert.rejects(
        () => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }),
        /second step failed/,
      );
      assert.deepStrictEqual(checkpointDetails, {
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
      });

      phase = 'retry';

      const result = await runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) });

      assert.deepStrictEqual(runCalls, [
        `initial:${buildTaskImplementationPrompt(worktree.taskDescription)}`,
        `initial:${buildChangeMetadataPrompt()}`,
        `retry:${buildChangeMetadataPrompt()}`,
      ]);
      assert.deepStrictEqual(result.completedStepIds, ['edit', 'change-metadata']);
      assert.deepStrictEqual(result.outputs[CHANGE_METADATA_OUTPUT_KEY], buildGeneratedChangeMetadata());
    } finally {
      restoreRuntime();
    }
  });

  it('rejects stale completed step ids from a checkpoint created for a different step sequence', async () => {
    const worktree = buildWorktreeContext();
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => {
        throw new Error('create should not be used when stale checkpoint data is present');
      },
      resumeCodexThread: () => {
        throw new Error('resume should not be used when stale checkpoint data is present');
      },
      getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: ['obsolete-step'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
      }),
      heartbeat: () => undefined,
    });

    try {
      await assert.rejects(
        () => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }),
        /stale completed step ids/i,
      );
    } finally {
      restoreRuntime();
    }
  });

  it('truncates large final responses before storing them in heartbeat checkpoints', async () => {
    const worktree = buildWorktreeContext();
    const heartbeatCalls: unknown[] = [];
    const largeResponse = `${'x'.repeat(300_000)}\ncompleted`;
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: 'thread-123',
        run: async () => ({ finalResponse: largeResponse }),
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      const result = await runAgentSequence({
        worktree,
        steps: [
          {
            id: 'edit',
            kind: 'prompt',
            prompt: buildTaskImplementationPrompt(worktree.taskDescription),
          },
        ],
      });

      assert.strictEqual(result.finalResponse, largeResponse);
      const pendingHeartbeat = heartbeatCalls.find(
        (details) =>
          typeof details === 'object' &&
          details !== null &&
          'pendingStep' in details &&
          typeof (details as { pendingStep?: { finalResponse?: unknown } }).pendingStep?.finalResponse === 'string',
      ) as { pendingStep: { finalResponse: string } } | undefined;
      assert.ok(pendingHeartbeat);
      assert.match(pendingHeartbeat.pendingStep.finalResponse, /truncated for Temporal heartbeat checkpoint/);
      assert.ok(Buffer.byteLength(pendingHeartbeat.pendingStep.finalResponse, 'utf8') <= 256 * 1024);
    } finally {
      restoreRuntime();
    }
  });

  it('finalizes a pending prompt-step completion from heartbeat details without rerunning Codex', async () => {
    const worktree = buildWorktreeContext();
    const heartbeatCalls: unknown[] = [];
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => {
        throw new Error('create should not be used when a pending prompt step is checkpointed');
      },
      resumeCodexThread: () => {
        throw new Error('resume should not be used when the pending checkpoint already completes the sequence');
      },
      getHeartbeatDetails: () => ({
        threadId: 'thread-123',
        completedStepIds: [],
        outputs: {},
        pendingStep: {
          stepId: 'edit',
          finalResponse: 'Implemented the requested change.',
        },
      }),
      heartbeat: (details: unknown) => {
        heartbeatCalls.push(details);
      },
    });

    try {
      const result = await runAgentSequence({
        worktree,
        steps: [
          {
            id: 'edit',
            kind: 'prompt',
            prompt: 'Implement the task in this repository.',
          },
        ],
      });

      assert.deepStrictEqual(result, {
        threadId: 'thread-123',
        completedStepIds: ['edit'],
        outputs: {},
        finalResponse: 'Implemented the requested change.',
      });
      assert.deepStrictEqual(heartbeatCalls, [
        {
          threadId: 'thread-123',
          completedStepIds: ['edit'],
          outputs: {},
          finalResponse: 'Implemented the requested change.',
        },
      ]);
    } finally {
      restoreRuntime();
    }
  });

  it('passes the Temporal cancellation signal to the structured agent path', async () => {
    const worktree = buildWorktreeContext();
    const abortController = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const restoreContext = mockActivityContext({ cancellationSignal: abortController.signal });
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: 'thread-123',
        run: async (_prompt: string, options?: { signal?: AbortSignal }) => {
          signals.push(options?.signal);
          return { finalResponse: 'Implemented the requested change.' };
        },
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
    });

    try {
      const result = await runAgentSequence({
        worktree,
        steps: [
          {
            id: 'edit',
            kind: 'prompt',
            prompt: 'Implement the task in this repository.',
          },
        ],
      });

      assert.strictEqual(result.threadId, 'thread-123');
      assert.deepStrictEqual(signals, [abortController.signal]);
    } finally {
      restoreRuntime();
      restoreContext();
    }
  });

  it('propagates CancelledFailure raised by Temporal heartbeat delivery', async () => {
    const worktree = buildWorktreeContext();
    const restoreContext = mockActivityContext({
      heartbeat: () => {
        throw new CancelledFailure('cancelled');
      },
      info: { heartbeatDetails: undefined },
    } as unknown as Partial<Context>);
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: 'thread-123',
        run: async () => ({ finalResponse: 'Implemented the requested change.' }),
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
    });

    try {
      await assert.rejects(
        () =>
          runAgentSequence({
            worktree,
            steps: [
              {
                id: 'edit',
                kind: 'prompt',
                prompt: buildTaskImplementationPrompt(worktree.taskDescription),
              },
            ],
          }),
        CancelledFailure,
      );
    } finally {
      restoreRuntime();
      restoreContext();
    }
  });

  it('prioritizes CancelledFailure over a concurrent thread.run failure', async () => {
    const worktree = buildWorktreeContext();
    let heartbeatCount = 0;
    const restoreContext = mockActivityContext({
      heartbeat: () => {
        heartbeatCount += 1;
        if (heartbeatCount >= 2) {
          throw new CancelledFailure('cancelled');
        }
      },
      info: { heartbeatDetails: undefined },
    } as unknown as Partial<Context>);
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: 'thread-123',
        run: async () => {
          throw new Error('thread run failed');
        },
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
    });

    try {
      await assert.rejects(
        () =>
          runAgentSequence({
            worktree,
            steps: [
              {
                id: 'edit',
                kind: 'prompt',
                prompt: buildTaskImplementationPrompt(worktree.taskDescription),
              },
            ],
          }),
        CancelledFailure,
      );
    } finally {
      restoreRuntime();
      restoreContext();
    }
  });

  it('propagates heartbeat detail access failures that are not missing-context errors', async () => {
    const worktree = buildWorktreeContext();
    const restoreContext = mockActivityContext({
      info: {
        get heartbeatDetails() {
          throw new Error('heartbeat detail deserialization failed');
        },
      },
      heartbeat: () => undefined,
    } as unknown as Partial<Context>);
    const restoreRuntime = mockActivityRuntime({});

    try {
      await assert.rejects(
        () => runAgentSequence({ worktree, steps: buildStructuredAgentSteps(worktree) }),
        /heartbeat detail deserialization failed/,
      );
    } finally {
      restoreRuntime();
      restoreContext();
    }
  });

  it('fails when the Codex thread id is still unavailable after a step completes', async () => {
    const worktree = buildWorktreeContext();
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({
        id: null,
        run: async () => ({ finalResponse: 'Implemented the requested change.' }),
      }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
    });

    try {
      await assert.rejects(
        () =>
          runAgentSequence({
            worktree,
            steps: [
              {
                id: 'edit',
                kind: 'prompt',
                prompt: 'Implement the task in this repository.',
              },
            ],
          }),
        /thread id was unavailable after completing step edit/,
      );
    } finally {
      restoreRuntime();
    }
  });

  it('fails fast when the Codex SDK returns a thread without a callable run method', async () => {
    const worktree = buildWorktreeContext();
    const restoreRuntime = mockActivityRuntime({
      createCodexThread: () => ({ id: 'thread-123' } as unknown as { id: string; run: never }),
      resumeCodexThread: () => {
        throw new Error('resume should not be used without a checkpoint');
      },
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
    });

    try {
      await assert.rejects(
        () =>
          runAgentSequence({
            worktree,
            steps: [
              {
                id: 'edit',
                kind: 'prompt',
                prompt: 'Implement the task in this repository.',
              },
            ],
          }),
        /callable run\(\) method/,
      );
    } finally {
      restoreRuntime();
    }
  });

  it('rejects duplicate structured agent step ids', async () => {
    const worktree = buildWorktreeContext();

    await assert.rejects(
      () =>
        runAgentSequence({
          worktree,
          steps: [
            {
              id: 'duplicate',
              kind: 'prompt',
              prompt: 'Implement the task in this repository.',
            },
            {
              id: 'duplicate',
              kind: 'structured',
              prompt: buildChangeMetadataPrompt(),
              schemaId: 'change-metadata-v1',
              resultKey: CHANGE_METADATA_OUTPUT_KEY,
            },
          ],
        }),
      /Duplicate id: duplicate/,
    );
  });

  it('rejects empty structured agent step sequences', async () => {
    const worktree = buildWorktreeContext();

    await assert.rejects(
      () =>
        (runAgentSequence as unknown as (input: { worktree: WorktreeContext; steps: AgentStep[] }) => Promise<unknown>)({
          worktree,
          steps: [],
        }),
      /must not be empty/,
    );
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
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '1\n', stderr: '', exitCode: 0 };
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
          cwd: worktree.repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName],
        },
        {
          cwd: worktree.worktreePath,
          args: ['rev-list', '--count', `origin/${worktree.defaultBranch}..HEAD`],
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

  it('uses the agent-provided commit message when committing staged changes', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '1\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      await commitAndPush({ worktree, commitMessage: 'feat: generate metadata from Codex' });

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
          args: ['commit', '-m', 'feat: generate metadata from Codex'],
        },
        {
          cwd: worktree.repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName],
        },
        {
          cwd: worktree.worktreePath,
          args: ['rev-list', '--count', `origin/${worktree.defaultBranch}..HEAD`],
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

  it('skips commit but still pushes when commitAndPush is retried with an unpushed local commit', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '1\n', stderr: '', exitCode: 0 };
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
          cwd: worktree.repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName],
        },
        {
          cwd: worktree.worktreePath,
          args: ['rev-list', '--count', `origin/${worktree.defaultBranch}..HEAD`],
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

  it('fails instead of pushing an unchanged branch when the agent produced no diff', async () => {
    const worktree = buildWorktreeContext();
    const gitCalls: GitCall[] = [];
    const restoreRuntime = mockActivityRuntime({
      execFile: async (_file, args, options) => {
        gitCalls.push({ args, cwd: options?.cwd });
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'ls-remote') {
          return { stdout: '', stderr: '', exitCode: 2 };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '0\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'push') {
          throw new Error('push should be skipped when there are no commits to publish');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      await assert.rejects(() => commitAndPush({ worktree }), /produced no changes to push/);

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
          cwd: worktree.repoRoot,
          args: ['ls-remote', '--exit-code', '--heads', 'origin', worktree.branchName],
        },
        {
          cwd: worktree.worktreePath,
          args: ['rev-list', '--count', `origin/${worktree.defaultBranch}..HEAD`],
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

  it('uses agent-provided pull request metadata when opening a pull request', async () => {
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
      await withGitHubToken(() =>
        openPullRequest({
          worktree,
          title: 'feat: generate commit and PR metadata',
          body: '## Summary\n- ask Codex for structured metadata in the same thread',
        }),
      );

      assert.deepStrictEqual(JSON.parse(String(fetchCalls[1].init?.body)), {
        title: 'feat: generate commit and PR metadata',
        head: worktree.branchName,
        base: worktree.defaultBranch,
        body: '## Summary\n- ask Codex for structured metadata in the same thread',
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
    readyOptionId: 'ready-option',
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
    blockedOptionId: 'blocked-option',
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

function buildProjectQueryResponse(
  issue: SelectedProjectIssue,
  options?: {
    items?: unknown[];
    hasNextPage?: boolean;
    endCursor?: string | null;
  },
): unknown {
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
                  { id: issue.readyOptionId, name: issue.readyStatusName },
                  { id: issue.inProgressOptionId, name: 'In progress' },
                  { id: issue.inReviewOptionId, name: issue.inReviewStatusName },
                  ...(issue.blockedOptionId ? [{ id: issue.blockedOptionId, name: 'Blocked' }] : []),
                ],
              },
            ],
          },
          items: {
            pageInfo: {
              hasNextPage: options?.hasNextPage ?? false,
              endCursor: options?.endCursor ?? null,
            },
            nodes: options?.items ?? [buildProjectItemNode(issue)],
          },
        },
      },
    },
  };
}

function buildProjectItemNode(
  issue: SelectedProjectIssue,
  options?: { id?: string; statusName?: string },
): unknown {
  return {
    id: options?.id ?? issue.projectItemId,
    fieldValueByName: {
      __typename: 'ProjectV2ItemFieldSingleSelectValue',
      name: options?.statusName ?? issue.readyStatusName,
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

function mockActivityRuntime(overrides: Partial<typeof activityRuntime> & Record<string, unknown>): () => void {
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

function buildGeneratedChangeMetadata(): Record<string, string> {
  return {
    commitMessage: 'feat: generate metadata from Codex',
    pullRequestTitle: 'feat: generate commit and PR metadata',
    pullRequestBody: '## Summary\n- ask Codex for structured metadata in the same thread',
  };
}

function buildStructuredAgentSteps(worktree: WorktreeContext): [AgentStep, ...AgentStep[]] {
  return [
    {
      id: 'edit',
      kind: 'prompt',
      prompt: buildTaskImplementationPrompt(worktree.taskDescription),
    },
    {
      id: 'change-metadata',
      kind: 'structured',
      prompt: buildChangeMetadataPrompt(),
      schemaId: 'change-metadata-v1',
      resultKey: CHANGE_METADATA_OUTPUT_KEY,
    },
  ];
}

function mockActivityContext(context: Partial<Context>): () => void {
  const originalCurrent = Context.current;
  Context.current = (() => context as Context) as typeof Context.current;

  return () => {
    Context.current = originalCurrent;
  };
}