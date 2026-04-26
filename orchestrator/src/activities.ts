import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_FILE_PATH_PREFIX,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_STATUS,
  type CleanupWorktreeInput,
  type CommitAndPushInput,
  type CreateWorktreeForIssueIfNeededInput,
  type CreatedPullRequest,
  type IssueCommentInput,
  type MoveProjectItemStatusInput,
  type OpenPullRequestInput,
  type RunAgentInput,
  type SelectedProjectIssue,
  type AutomateReadyIssueInput,
  type WorktreeContext,
} from './shared';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = `${GITHUB_API_URL}/graphql`;
const GITHUB_JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;
const LOCAL_REPOS_ROOT = '/tmp/orchestrator';
const LOCAL_WORKTREES_DIR = '.worktrees';
const LOCAL_WORKTREES_EXCLUDE_ENTRY = '.worktrees/';
const PROJECT_STATUS_FIELD_NAME = 'Status';
const PROJECT_ITEMS_FIRST = 100;
const CODEX_COMMAND = 'codex';
const CODEX_MODEL = 'gpt-5.3-codex';
const CODEX_REASONING_EFFORT = 'low';

interface GitHubGraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ProjectQueryData {
  owner: ProjectOwner | null;
}

interface ProjectOwner {
  projectV2: ProjectData | null;
}

interface ProjectData {
  id: string;
  fields: { nodes: ProjectFieldNode[] };
  items: { nodes: ProjectItemNode[] };
}

type ProjectFieldNode =
  | {
      __typename: 'ProjectV2SingleSelectField';
      id: string;
      name: string;
      options: Array<{ id: string; name: string }>;
    }
  | { __typename: string };

interface ProjectItemNode {
  id: string;
  fieldValueByName: null | {
    __typename: 'ProjectV2ItemFieldSingleSelectValue';
    name: string;
  };
  content:
    | null
    | {
        __typename: 'Issue';
        number: number;
        title: string;
        body: string;
        url: string;
        repository: {
          name: string;
          owner: { login: string };
          defaultBranchRef: null | { name: string };
        };
      }
    | { __typename: string };
}

type ProjectSingleSelectField = Extract<ProjectFieldNode, { __typename: 'ProjectV2SingleSelectField' }>;
type ProjectIssueContent = Extract<NonNullable<ProjectItemNode['content']>, { __typename: 'Issue' }>;
type ProjectStatusOption = ProjectSingleSelectField['options'][number];
type ReadyProjectItem = ProjectItemNode & { content: ProjectIssueContent };

interface PullRequestResponse {
  number: number;
  html_url: string;
}

interface CommandOptions {
  cwd?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface LocalRepoPaths {
  repoRoot: string;
  worktreesRoot: string;
  worktreePath: string;
  remoteUrl: string;
}

interface ActivityRuntime {
  fetch: typeof fetch;
  access: (targetPath: string) => Promise<void>;
  mkdir: typeof mkdir;
  appendFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  writeFile: (targetPath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  execFile: (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
  now: () => number;
}

export const activityRuntime: ActivityRuntime = {
  fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
  access,
  mkdir,
  appendFile: (targetPath, data, encoding) => appendFile(targetPath, data, encoding),
  writeFile: (targetPath, data, encoding) => writeFile(targetPath, data, encoding),
  execFile: defaultExecFile,
  now: () => Date.now(),
};

const PROJECT_FIELDS_FRAGMENT = `
  fragment ProjectFields on ProjectV2 {
    id
    fields(first: 50) {
      nodes {
        __typename
        ... on ProjectV2SingleSelectField {
          id
          name
          options {
            id
            name
          }
        }
      }
    }
    items(first: $itemsFirst) {
      nodes {
        id
        fieldValueByName(name: "${PROJECT_STATUS_FIELD_NAME}") {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
          }
        }
        content {
          __typename
          ... on Issue {
            number
            title
            body
            url
            repository {
              name
              owner {
                login
              }
              defaultBranchRef {
                name
              }
            }
          }
        }
      }
    }
  }
`;

const USER_PROJECT_QUERY = `
  query UserProjectIssueSelection($login: String!, $number: Int!, $itemsFirst: Int!) {
    owner: user(login: $login) {
      projectV2(number: $number) {
        ...ProjectFields
      }
    }
  }

  ${PROJECT_FIELDS_FRAGMENT}
`;

const ORGANIZATION_PROJECT_QUERY = `
  query OrganizationProjectIssueSelection($login: String!, $number: Int!, $itemsFirst: Int!) {
    owner: organization(login: $login) {
      projectV2(number: $number) {
        ...ProjectFields
      }
    }
  }

  ${PROJECT_FIELDS_FRAGMENT}
`;

const MOVE_PROJECT_ITEM_MUTATION = `
  mutation MoveProjectItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

export function buildBranchName(issueNumber: number, branchPrefix = DEFAULT_BRANCH_PREFIX): string {
  return `${branchPrefix}/issue-${issueNumber}`;
}

export function buildDummyFilePath(issueNumber: number, filePathPrefix = DEFAULT_FILE_PATH_PREFIX): string {
  return `${filePathPrefix}/issue-${issueNumber}.md`;
}

export function buildDummyChangeContent(
  issueNumber: number,
  issueTitle: string,
  generatedAt = new Date(Date.now()).toISOString(),
): string {
  return [
    '# Orchestrator Dummy Change',
    '',
    `- Issue: #${issueNumber}`,
    `- Title: ${issueTitle}`,
    `- Generated at: ${generatedAt}`,
  ].join('\n');
}

export function buildIssueComment(pullRequestUrl: string): string {
  return `Opened a pull request for this issue: ${pullRequestUrl}`;
}

export async function getTopReadyIssue(input: AutomateReadyIssueInput): Promise<SelectedProjectIssue> {
  const readyStatusName = input.readyStatusName ?? DEFAULT_READY_STATUS;
  const inProgressStatusName = DEFAULT_IN_PROGRESS_STATUS;
  const inReviewStatusName = input.inReviewStatusName ?? DEFAULT_IN_REVIEW_STATUS;
  const project = await lookupProject(input.projectOwner, input.projectNumber);
  const statusField = getProjectStatusField(project);
  const inProgressOption = getRequiredStatusOption(statusField, inProgressStatusName);
  const inReviewOption = getRequiredStatusOption(statusField, inReviewStatusName);
  const readyItem = getReadyIssueItem(
    project,
    readyStatusName,
    input.projectOwner,
    input.projectNumber,
  );
  const readyIssue = readyItem.content;

  return {
    projectId: project.id,
    projectItemId: readyItem.id,
    statusFieldId: statusField.id,
    inProgressOptionId: inProgressOption.id,
    inReviewOptionId: inReviewOption.id,
    issueNumber: readyIssue.number,
    issueTitle: readyIssue.title,
    taskDescription: buildTaskDescription(readyIssue.title, readyIssue.body),
    issueUrl: readyIssue.url,
    repoOwner: readyIssue.repository.owner.login,
    repoName: readyIssue.repository.name,
    defaultBranch: readyIssue.repository.defaultBranchRef?.name ?? 'main',
    readyStatusName,
    inReviewStatusName,
  };
}

async function lookupProject(projectOwner: string, projectNumber: number): Promise<ProjectData> {
  const variables = {
    login: projectOwner,
    number: projectNumber,
    itemsFirst: PROJECT_ITEMS_FIRST,
  };

  const userOwner = await lookupProjectOwner(USER_PROJECT_QUERY, variables, 'User');
  if (userOwner?.projectV2) {
    return userOwner.projectV2;
  }
  if (userOwner) {
    throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
  }

  const organizationOwner = await lookupProjectOwner(ORGANIZATION_PROJECT_QUERY, variables, 'Organization');
  if (organizationOwner?.projectV2) {
    return organizationOwner.projectV2;
  }

  throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
}

async function lookupProjectOwner(
  query: string,
  variables: Record<string, unknown>,
  ownerType: 'User' | 'Organization',
): Promise<ProjectOwner | null> {
  try {
    const data = await githubGraphql<ProjectQueryData>(query, variables);
    return data.owner;
  } catch (error) {
    if (isMissingProjectOwnerError(error, ownerType)) {
      return null;
    }
    throw error;
  }
}

function getProjectStatusField(project: ProjectData): ProjectSingleSelectField {
  const statusField = project.fields.nodes.find(
    (field): field is ProjectSingleSelectField =>
      isProjectSingleSelectField(field) && field.name === PROJECT_STATUS_FIELD_NAME,
  );

  if (!statusField) {
    throw new Error('The GitHub Project does not contain a Status field.');
  }

  return statusField;
}

function getRequiredStatusOption(
  statusField: ProjectSingleSelectField,
  statusName: string,
): ProjectStatusOption {
  const statusOption = statusField.options.find((option) => option.name === statusName);

  if (!statusOption) {
    throw new Error(`Could not find the ${statusName} status option on the GitHub Project.`);
  }

  return statusOption;
}

function getReadyIssueItem(
  project: ProjectData,
  readyStatusName: string,
  projectOwner: string,
  projectNumber: number,
): ReadyProjectItem {
  const readyItem = project.items.nodes.find(
    (item): item is ReadyProjectItem =>
      item.fieldValueByName?.name === readyStatusName && isProjectIssueContent(item.content),
  );

  if (!readyItem) {
    throw new Error(`Could not find a Ready issue in GitHub Project ${projectOwner}/${projectNumber}.`);
  }

  return readyItem;
}

export async function createWorktreeForIssueIfNeeded(
  input: CreateWorktreeForIssueIfNeededInput,
): Promise<WorktreeContext> {
  const { issue, branchPrefix, filePathPrefix } = input;
  const { defaultBranch, issueNumber, repoName, repoOwner } = issue;
  const generatedAt = new Date(activityRuntime.now()).toISOString();
  const branchName = buildBranchName(issueNumber, branchPrefix);
  const filePath = buildDummyFilePath(issueNumber, filePathPrefix);
  const localRepoPaths = resolveLocalRepoPaths(repoOwner, repoName, branchName);
  const worktree = buildWorktreeContext(issue, branchName, filePath, generatedAt, localRepoPaths);

  if (await pathExists(localRepoPaths.worktreePath)) {
    return worktree;
  }

  await ensureBaseClone(localRepoPaths);
  await ensureWorktreesIgnored(localRepoPaths);
  await refreshCloneToDefaultBranch(localRepoPaths.repoRoot, defaultBranch);

  await ensureIssueWorktree(localRepoPaths.repoRoot, localRepoPaths.worktreePath, branchName, defaultBranch);

  return worktree;
}

function buildWorktreeContext(
  issue: SelectedProjectIssue,
  branchName: string,
  filePath: string,
  generatedAt: string,
  localRepoPaths: Pick<LocalRepoPaths, 'repoRoot' | 'worktreePath'>,
): WorktreeContext {
  const { defaultBranch, issueNumber, issueTitle, taskDescription, issueUrl, repoName, repoOwner } = issue;

  return {
    issueNumber,
    issueTitle,
    taskDescription,
    issueUrl,
    repoOwner,
    repoName,
    defaultBranch,
    branchName,
    filePath,
    generatedAt,
    repoRoot: localRepoPaths.repoRoot,
    worktreePath: localRepoPaths.worktreePath,
  };
}

export async function runAgent(input: RunAgentInput): Promise<void> {
  const { worktree } = input;
  await codex(worktree.worktreePath, buildCodexPrompt(worktree));
}

export async function runDummyAgent(input: RunAgentInput): Promise<void> {
  const { worktree } = input;
  await writeDummyFile(
    worktree.worktreePath,
    worktree.filePath,
    buildDummyChangeContent(worktree.issueNumber, worktree.issueTitle, worktree.generatedAt),
  );
}

export async function commitAndPush(input: CommitAndPushInput): Promise<void> {
  const { worktree } = input;
  const { branchName, worktreePath } = worktree;
  await git(worktreePath, ['add', '--all']);
  await commitWorktreeIfNeeded(worktree);
  await git(worktreePath, ['push', '-u', 'origin', branchName]);
}

export async function openPullRequest(input: OpenPullRequestInput): Promise<CreatedPullRequest> {
  const { worktree } = input;
  const existingPullRequest = await findOpenPullRequestForBranch(worktree);
  if (existingPullRequest) {
    return buildCreatedPullRequest(worktree, existingPullRequest);
  }

  return buildCreatedPullRequest(worktree, await createPullRequestWithDuplicateRecovery(worktree));
}

async function createPullRequestWithDuplicateRecovery(worktree: WorktreeContext): Promise<PullRequestResponse> {
  try {
    return await createPullRequest(worktree);
  } catch (error) {
    if (!isPullRequestAlreadyExistsError(error)) {
      throw error;
    }

    const existingPullRequest = await findOpenPullRequestForBranch(worktree);
    if (existingPullRequest) {
      return existingPullRequest;
    }

    throw error;
  }
}

function resolveLocalRepoPaths(repoOwner: string, repoName: string, branchName: string): LocalRepoPaths {
  const repoRoot = path.join(LOCAL_REPOS_ROOT, repoOwner, repoName);
  const worktreesRoot = path.join(repoRoot, LOCAL_WORKTREES_DIR);

  return {
    repoRoot,
    worktreesRoot,
    worktreePath: path.join(worktreesRoot, branchName),
    remoteUrl: `https://github.com/${repoOwner}/${repoName}.git`,
  };
}

function buildTaskDescription(issueTitle: string, issueBody: string): string {
  const description = issueBody.trim();
  return description.length > 0 ? description : issueTitle;
}

function buildCodexPrompt(worktree: WorktreeContext): string {
  return `Implement the task in this repository.\n\nTask description:\n${worktree.taskDescription}`;
}

function buildRepoApiPath(repoOwner: string, repoName: string): string {
  return `/repos/${repoOwner}/${repoName}`;
}

function buildCodexArgs(prompt: string): string[] {
  return [
    'exec',
    '--full-auto',
    '--model',
    CODEX_MODEL,
    '--config',
    `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    prompt,
  ];
}

async function codex(cwd: string, prompt: string): Promise<CommandResult> {
  return execCommand(CODEX_COMMAND, buildCodexArgs(prompt), { cwd });
}

async function ensureBaseClone(paths: LocalRepoPaths): Promise<void> {
  if (!(await pathExists(paths.repoRoot))) {
    await activityRuntime.mkdir(path.dirname(paths.repoRoot), { recursive: true });
    await git(path.dirname(paths.repoRoot), ['clone', paths.remoteUrl, paths.repoRoot]);
    return;
  }

  await git(paths.repoRoot, ['fetch', '--prune', 'origin']);
}

async function ensureWorktreesIgnored(paths: LocalRepoPaths): Promise<void> {
  const result = await git(paths.repoRoot, ['check-ignore', LOCAL_WORKTREES_DIR], [0, 1]);
  if (result.exitCode !== 0) {
    const gitInfoPath = path.join(paths.repoRoot, '.git', 'info');
    await activityRuntime.mkdir(gitInfoPath, { recursive: true });
    await activityRuntime.appendFile(path.join(gitInfoPath, 'exclude'), `${LOCAL_WORKTREES_EXCLUDE_ENTRY}\n`, 'utf8');
  }

  await activityRuntime.mkdir(paths.worktreesRoot, { recursive: true });
}

async function refreshCloneToDefaultBranch(repoRoot: string, defaultBranch: string): Promise<void> {
  await git(repoRoot, ['checkout', '-B', defaultBranch, `origin/${defaultBranch}`]);
}

async function hasRemoteBranch(repoRoot: string, branchName: string): Promise<boolean> {
  const result = await git(repoRoot, ['ls-remote', '--exit-code', '--heads', 'origin', branchName], [0, 2]);
  return result.exitCode === 0;
}

async function hasStagedChanges(worktreePath: string): Promise<boolean> {
  const result = await git(worktreePath, ['diff', '--cached', '--quiet', '--exit-code'], [0, 1]);
  return result.exitCode === 1;
}

async function commitWorktreeIfNeeded(worktree: WorktreeContext): Promise<void> {
  if (!(await hasStagedChanges(worktree.worktreePath))) {
    return;
  }

  await git(worktree.worktreePath, ['commit', '-m', `Add dummy change for issue #${worktree.issueNumber}`]);
}

async function findOpenPullRequestForBranch(worktree: WorktreeContext): Promise<PullRequestResponse | undefined> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);
  const query = new URLSearchParams({
    head: `${worktree.repoOwner}:${worktree.branchName}`,
    state: 'open',
    base: worktree.defaultBranch,
  });
  const pullRequests = await githubRest<PullRequestResponse[]>(`${repoPath}/pulls?${query.toString()}`);

  return pullRequests[0];
}

function buildCreatedPullRequest(worktree: WorktreeContext, pullRequest: PullRequestResponse): CreatedPullRequest {
  return {
    branchName: worktree.branchName,
    filePath: worktree.filePath,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
  };
}

async function createPullRequest(worktree: WorktreeContext): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);

  return githubRest<PullRequestResponse>(`${repoPath}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `chore: dummy change for #${worktree.issueNumber}`,
      head: worktree.branchName,
      base: worktree.defaultBranch,
      body: `Automated dummy change for ${worktree.issueUrl}`,
    }),
  });
}

async function ensureIssueWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  defaultBranch: string,
): Promise<void> {
  if (await hasRemoteBranch(repoRoot, branchName)) {
    await createWorktreeFromRemoteBranch(repoRoot, worktreePath, branchName);
    return;
  }

  await createBranchWorktree(repoRoot, worktreePath, branchName, defaultBranch);
}

async function createBranchWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  defaultBranch: string,
): Promise<void> {
  await git(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, `origin/${defaultBranch}`]);
}

async function createWorktreeFromRemoteBranch(repoRoot: string, worktreePath: string, branchName: string): Promise<void> {
  await git(repoRoot, ['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
}

async function writeDummyFile(worktreePath: string, relativeFilePath: string, content: string): Promise<void> {
  const absoluteFilePath = path.join(worktreePath, relativeFilePath);
  await activityRuntime.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await activityRuntime.writeFile(absoluteFilePath, content, 'utf8');
}

async function cleanupLocalWorktree(repoRoot: string, worktreePath: string, branchName: string): Promise<void> {
  const cleanupFailures: string[] = [];

  try {
    await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    cleanupFailures.push(toErrorMessage(error));
  }

  try {
    await git(repoRoot, ['branch', '-D', branchName]);
  } catch (error) {
    cleanupFailures.push(toErrorMessage(error));
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Failed to clean up worktree ${worktreePath}: ${cleanupFailures.join('; ')}`);
  }
}

export async function cleanupWorktree(input: CleanupWorktreeInput): Promise<void> {
  const { worktree } = input;
  await cleanupLocalWorktree(worktree.repoRoot, worktree.worktreePath, worktree.branchName);
}

export async function commentOnIssue(input: IssueCommentInput): Promise<void> {
  const repoPath = buildRepoApiPath(input.repoOwner, input.repoName);

  await githubRest(`${repoPath}/issues/${input.issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: buildIssueComment(input.pullRequestUrl) }),
  });
}

export async function moveProjectItemStatus(input: MoveProjectItemStatusInput): Promise<void> {
  await githubGraphql(MOVE_PROJECT_ITEM_MUTATION, {
    projectId: input.projectId,
    itemId: input.projectItemId,
    fieldId: input.statusFieldId,
    optionId: input.statusOptionId,
  });
}

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('Set GITHUB_TOKEN or GH_TOKEN on the worker process before running GitHub activities.');
  }
  return token;
}

async function githubRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await activityRuntime.fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getGitHubToken()}`,
      ...GITHUB_JSON_HEADERS,
      ...init.headers,
    },
  });

  return parseGitHubResponse<T>(response);
}

async function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await activityRuntime.fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getGitHubToken()}`,
      ...GITHUB_JSON_HEADERS,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await parseGitHubResponse<GitHubGraphqlEnvelope<T>>(response);

  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${payload.errors.map((error) => error.message).join('; ')}`);
  }
  if (!payload.data) {
    throw new Error('GitHub GraphQL response did not contain data.');
  }

  return payload.data;
}

async function parseGitHubResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status} ${response.statusText}): ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await activityRuntime.access(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: string[], allowedExitCodes: number[] = [0]): Promise<CommandResult> {
  return execCommand('git', args, { cwd }, allowedExitCodes);
}

async function execCommand(
  file: string,
  args: string[],
  options: CommandOptions = {},
  allowedExitCodes: number[] = [0],
): Promise<CommandResult> {
  let result: CommandResult;

  try {
    result = await activityRuntime.execFile(file, args, options);
  } catch (error) {
    throw new Error(`${file} ${args.join(' ')} failed in ${options.cwd ?? process.cwd()}: ${toErrorMessage(error)}`);
  }

  if (!allowedExitCodes.includes(result.exitCode)) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`${file} ${args.join(' ')} failed in ${options.cwd ?? process.cwd()}: ${details}`);
  }

  return result;
}

async function defaultExecFile(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await execa(file, args, {
    cwd: options.cwd,
    reject: false,
    stdin: 'ignore',
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPullRequestAlreadyExistsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('gitHub request failed'.toLowerCase()) && message.includes('422') && message.includes('pull request already exists');
}

function isMissingProjectOwnerError(error: unknown, ownerType: 'User' | 'Organization'): boolean {
  return error instanceof Error && error.message.includes(`Could not resolve to a ${ownerType} with the login of`);
}

function isProjectSingleSelectField(field: ProjectFieldNode): field is ProjectSingleSelectField {
  return field.__typename === 'ProjectV2SingleSelectField';
}

function isProjectIssueContent(content: ProjectItemNode['content'] | undefined): content is ProjectIssueContent {
  return content?.__typename === 'Issue';
}