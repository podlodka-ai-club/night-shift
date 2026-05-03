import type { AgentActivityDeps, GitHubActivityDeps, WorktreeActivityDeps } from '../activity-deps';
import { CODEX_MODEL, CODEX_REASONING_EFFORT } from '../activity-deps';
import { buildChangeMetadataPrompt, buildTaskImplementationPrompt } from '../agent-prompts';
import {
  buildBranchName,
  createActivities,
  createActivityDependencies,
} from '../activities';
import {
  CHANGE_METADATA_OUTPUT_KEY,
  type AgentStep,
  type CreatedPullRequest,
  type SelectedProjectIssue,
  type WorktreeContext,
} from '../shared';

const TEST_GITHUB_TOKEN = 'test-token';
export const TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX = 'Test must override createActivityTestRig dependency before exercising external behavior:';

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export interface GitCall {
  cwd?: string;
  args: string[];
}

export interface MkdirCall {
  path: string;
  options: unknown;
}

export interface AppendCall {
  path: string;
  data: string;
  encoding: BufferEncoding;
}

export interface WriteCall {
  path: string;
  data: string;
  encoding: BufferEncoding;
}

interface ActivityTestRigOptions {
  github?: Partial<GitHubActivityDeps>;
  worktree?: Partial<WorktreeActivityDeps>;
  agent?: Partial<AgentActivityDeps>;
}

export function createActivityTestRig(options: ActivityTestRigOptions = {}) {
  const defaultDeps = createActivityDependencies();

  return createActivities({
    github: {
      fetch: async () => failUnmockedDependency('github.fetch'),
      getGitHubToken: () => TEST_GITHUB_TOKEN,
      ...options.github,
    },
    worktree: {
      access: async () => failUnmockedDependency('worktree.access'),
      mkdir: async () => failUnmockedDependency('worktree.mkdir'),
      readdir: async () => failUnmockedDependency('worktree.readdir'),
      readFile: async () => failUnmockedDependency('worktree.readFile'),
      realpath: async () => failUnmockedDependency('worktree.realpath'),
      rm: async () => failUnmockedDependency('worktree.rm'),
      appendFile: async () => failUnmockedDependency('worktree.appendFile'),
      writeFile: async () => failUnmockedDependency('worktree.writeFile'),
      execFile: async () => failUnmockedDependency('worktree.execFile'),
      now: defaultDeps.now,
      ...options.worktree,
    },
    agent: {
      access: async () => failUnmockedDependency('agent.access'),
      mkdir: async () => failUnmockedDependency('agent.mkdir'),
      readdir: async () => failUnmockedDependency('agent.readdir'),
      readFile: async () => failUnmockedDependency('agent.readFile'),
      realpath: async () => failUnmockedDependency('agent.realpath'),
      rm: async () => failUnmockedDependency('agent.rm'),
      appendFile: async () => failUnmockedDependency('agent.appendFile'),
      writeFile: async () => failUnmockedDependency('agent.writeFile'),
      execFile: async () => failUnmockedDependency('agent.execFile'),
      createCodexThread: () => failUnmockedDependency('agent.createCodexThread'),
      resumeCodexThread: () => failUnmockedDependency('agent.resumeCodexThread'),
      getAgentProfile: () => ({ model: CODEX_MODEL, reasoningEffort: CODEX_REASONING_EFFORT }),
      createClaudeSession: () => failUnmockedDependency('agent.createClaudeSession'),
      resumeClaudeSession: () => failUnmockedDependency('agent.resumeClaudeSession'),
      getHeartbeatDetails: () => undefined,
      heartbeat: () => undefined,
      signalProgress: async () => undefined,
      getCancellationSignal: () => undefined,
      ...options.agent,
    },
  });
}

export function createFetchSequenceMock(responses: Response[], calls: FetchCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const nextResponse = responses.shift();
    if (!nextResponse) {
      throw new Error('Unexpected fetch call in test.');
    }
    return nextResponse;
  }) as typeof fetch;
}

function failUnmockedDependency(dependencyName: string): never {
  throw new Error(`${TEST_RIG_UNMOCKED_DEPENDENCY_PREFIX} ${dependencyName}`);
}

export function buildSelectedIssue(): SelectedProjectIssue {
  return {
    projectId: 'project-1',
    projectItemId: 'item-1',
    statusFieldId: 'status-field',
    backlogOptionId: 'backlog-option',
    refinementOptionId: 'refinement-option',
    refinedOptionId: 'refined-option',
    readyOptionId: 'ready-option',
    inProgressOptionId: 'progress-option',
    inReviewOptionId: 'review-option',
    readyToMergeOptionId: 'ready-to-merge-option',
    escalatedOptionId: 'escalated-option',
    blockedOptionId: 'blocked-option',
    issueNumber: 7,
    issueTitle: 'Create a dummy PR',
    taskDescription: 'Implement the requested repository change for issue 7.',
    issueUrl: 'https://github.com/Mugenor/orchestrator-testing/issues/7',
    repoOwner: 'Mugenor',
    repoName: 'orchestrator-testing',
    defaultBranch: 'main',
    backlogStatusName: 'Backlog',
    refinementStatusName: 'Refinement',
    refinedStatusName: 'Refined',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    readyToMergeStatusName: 'Ready to merge',
    escalatedStatusName: 'Escalated',
  };
}

const DEFAULT_PROJECT_STATUS_OPTIONS = [
  { id: 'backlog-option', name: 'Backlog' },
  { id: 'refinement-option', name: 'Refinement' },
  { id: 'refined-option', name: 'Refined' },
  { id: 'ready-option', name: 'Ready' },
  { id: 'progress-option', name: 'In progress' },
  { id: 'review-option', name: 'In review' },
  { id: 'ready-to-merge-option', name: 'Ready to merge' },
  { id: 'escalated-option', name: 'Escalated' },
  { id: 'blocked-option', name: 'Blocked' },
] as const;

export function buildWorktreeContext(issue = buildSelectedIssue()): WorktreeContext {
  const branchName = buildBranchName(issue.issueNumber);
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
    generatedAt: '1970-01-01T00:00:00.123Z',
    repoRoot,
    worktreePath: `${repoRoot}/.worktrees/${branchName}`,
  };
}

export function buildProjectQueryResponse(
  issue: SelectedProjectIssue,
  options?: {
    items?: unknown[];
    hasNextPage?: boolean;
    endCursor?: string | null;
    statusOptions?: ReadonlyArray<{ id: string; name: string; color?: string; description?: string | null }>;
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
                options: options?.statusOptions ?? DEFAULT_PROJECT_STATUS_OPTIONS,
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

export function buildProjectItemNode(
  issue: SelectedProjectIssue,
  options?: { id?: string; statusName?: string; createdAt?: string },
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
      createdAt: options?.createdAt ?? '2026-04-28T09:00:00.000Z',
      labels: {
        nodes: (issue.labels ?? []).map((name) => ({ name })),
      },
      repository: {
        name: issue.repoName,
        owner: { login: issue.repoOwner },
        defaultBranchRef: { name: issue.defaultBranch },
      },
    },
  };
}

export function buildPullRequestsApiUrl(worktree: WorktreeContext): string {
  return `https://api.github.com/repos/${worktree.repoOwner}/${worktree.repoName}/pulls`;
}

export function buildOpenPullRequestLookupUrl(worktree: WorktreeContext): string {
  const query = new URLSearchParams({
    head: `${worktree.repoOwner}:${worktree.branchName}`,
    state: 'open',
    base: worktree.defaultBranch,
  });

  return `${buildPullRequestsApiUrl(worktree)}?${query.toString()}`;
}

export function buildPullRequestUrl(worktree: WorktreeContext, pullRequestNumber = 42): string {
  return `https://github.com/${worktree.repoOwner}/${worktree.repoName}/pull/${pullRequestNumber}`;
}

export function buildExpectedCreatedPullRequest(worktree: WorktreeContext, pullRequestNumber = 42): CreatedPullRequest {
  return {
    branchName: worktree.branchName,
    pullRequestNumber,
    pullRequestUrl: buildPullRequestUrl(worktree, pullRequestNumber),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createNotFoundError(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

export function buildGeneratedChangeMetadata(): Record<string, string> {
  return {
    commitMessage: 'feat: generate metadata from Codex',
    pullRequestTitle: 'feat: generate commit and PR metadata',
    pullRequestBody: '## Summary\n- ask Codex for structured metadata in the same thread',
  };
}

export function buildStructuredAgentSteps(worktree: WorktreeContext): [AgentStep, ...AgentStep[]] {
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