import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { execa } from 'execa';
import { buildTaskImplementationPrompt } from './agent-prompts';
import { getAgentSchema } from './agent-schema-registry';
import {
  AGENT_OUTPUT_KEYS,
  CHANGE_METADATA_OUTPUT_KEY,
  type AgentOutputKey,
  type AgentSequenceResult,
  type AgentStep,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_BLOCKED_STATUS,
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
  type RunAgentLegacyInput,
  type RunAgentSequenceInput,
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
const CODEX_REASONING_EFFORT = 'low' as const;
const AGENT_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_CHECKPOINT_FINAL_RESPONSE_BYTES = 256 * 1024;
const CHECKPOINT_TRUNCATION_SUFFIX = '\n...[truncated for Temporal heartbeat checkpoint]';

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
  items: {
    nodes: ProjectItemNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
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
  signal?: AbortSignal;
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
  createCodexThread: (worktreePath: string) => AgentThread;
  resumeCodexThread: (worktreePath: string, threadId: string) => AgentThread;
  getHeartbeatDetails: () => unknown;
  heartbeat: (details: unknown) => void;
}

interface AgentTurnResult {
  finalResponse: string;
}

interface AgentThread {
  readonly id: string | null;
  run: (prompt: string, options?: { outputSchema?: unknown; signal?: AbortSignal }) => Promise<AgentTurnResult>;
}

interface AgentCheckpoint {
  threadId?: string;
  completedStepIds?: string[];
  outputs?: AgentSequenceResult['outputs'];
  finalResponse?: string;
  pendingStep?: PendingStepCompletion;
}

interface PendingStepCompletion {
  stepId: string;
  finalResponse: string;
  output?: {
    resultKey: AgentOutputKey;
    parsedOutput: unknown;
  };
}

type CodexSdkModule = typeof import('@openai/codex-sdk');

const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

export const activityRuntime: ActivityRuntime = {
  fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
  access,
  mkdir,
  appendFile: (targetPath, data, encoding) => appendFile(targetPath, data, encoding),
  writeFile: (targetPath, data, encoding) => writeFile(targetPath, data, encoding),
  execFile: defaultExecFile,
  now: () => Date.now(),
  createCodexThread: (worktreePath) =>
    createLazyCodexThread('startThread', async () => {
      const { Codex } = await loadCodexSdk();
      return new Codex().startThread(buildCodexThreadOptions(worktreePath));
    }),
  resumeCodexThread: (worktreePath, threadId) =>
    createLazyCodexThread('resumeThread', async () => {
      const { Codex } = await loadCodexSdk();
      return new Codex().resumeThread(threadId, buildCodexThreadOptions(worktreePath));
    }),
  getHeartbeatDetails: () => getActivityHeartbeatDetails(),
  heartbeat: (details) => heartbeatActivity(details),
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
    items(first: $itemsFirst, after: $itemsAfter) {
      pageInfo {
        hasNextPage
        endCursor
      }
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
  query UserProjectIssueSelection($login: String!, $number: Int!, $itemsFirst: Int!, $itemsAfter: String) {
    owner: user(login: $login) {
      projectV2(number: $number) {
        ...ProjectFields
      }
    }
  }

  ${PROJECT_FIELDS_FRAGMENT}
`;

const ORGANIZATION_PROJECT_QUERY = `
  query OrganizationProjectIssueSelection($login: String!, $number: Int!, $itemsFirst: Int!, $itemsAfter: String) {
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
  const blockedStatusName = input.blockedStatusName ?? DEFAULT_BLOCKED_STATUS;
  const project = await lookupProject(input.projectOwner, input.projectNumber);
  const statusField = getProjectStatusField(project);
  const readyOption = getRequiredStatusOption(statusField, readyStatusName);
  const inProgressOption = getRequiredStatusOption(statusField, inProgressStatusName);
  const inReviewOption = getRequiredStatusOption(statusField, inReviewStatusName);
  const blockedOption = findStatusOption(statusField, blockedStatusName);
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
    readyOptionId: readyOption.id,
    inProgressOptionId: inProgressOption.id,
    inReviewOptionId: inReviewOption.id,
    blockedOptionId: blockedOption?.id,
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
    itemsAfter: null,
  };

  const userOwner = await lookupProjectOwner(USER_PROJECT_QUERY, variables, 'User');
  if (userOwner?.projectV2) {
    return paginateProjectItems(USER_PROJECT_QUERY, variables, 'User', userOwner.projectV2);
  }
  if (userOwner) {
    throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
  }

  const organizationOwner = await lookupProjectOwner(ORGANIZATION_PROJECT_QUERY, variables, 'Organization');
  if (organizationOwner?.projectV2) {
    return paginateProjectItems(ORGANIZATION_PROJECT_QUERY, variables, 'Organization', organizationOwner.projectV2);
  }

  throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
}

async function paginateProjectItems(
  query: string,
  variables: { login: string; number: number; itemsFirst: number; itemsAfter: string | null },
  ownerType: 'User' | 'Organization',
  firstPageProject: ProjectData,
): Promise<ProjectData> {
  const project: ProjectData = {
    ...firstPageProject,
    fields: {
      nodes: [...firstPageProject.fields.nodes],
    },
    items: {
      nodes: [...firstPageProject.items.nodes],
      pageInfo: { ...firstPageProject.items.pageInfo },
    },
  };

  while (project.items.pageInfo.hasNextPage) {
    const nextCursor = project.items.pageInfo.endCursor;
    const owner = await lookupProjectOwner(query, { ...variables, itemsAfter: nextCursor }, ownerType);
    const nextPageProject = owner?.projectV2;

    if (!nextPageProject) {
      throw new Error(`Could not continue loading GitHub Project pages for ${variables.login}/${variables.number}.`);
    }

    project.items.nodes.push(...nextPageProject.items.nodes);
    project.items.pageInfo = { ...nextPageProject.items.pageInfo };
  }

  return project;
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
  const statusOption = findStatusOption(statusField, statusName);

  if (!statusOption) {
    throw new Error(`Could not find the ${statusName} status option on the GitHub Project.`);
  }

  return statusOption;
}

function findStatusOption(
  statusField: ProjectSingleSelectField,
  statusName: string,
): ProjectStatusOption | undefined {
  return statusField.options.find((option) => option.name === statusName);
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

export async function runAgentLegacy(input: RunAgentLegacyInput): Promise<void> {
  const { worktree } = input;
  await codex(worktree.worktreePath, buildTaskImplementationPrompt(worktree.taskDescription));
}

export async function runAgentSequence(input: RunAgentSequenceInput): Promise<AgentSequenceResult> {
  if (input.steps.length === 0) {
    throw new Error('Agent step sequences must not be empty.');
  }

  return runAgentSequenceSteps(input.worktree, input.steps);
}

export async function runDummyAgent(input: { worktree: WorktreeContext }): Promise<void> {
  const { worktree } = input;
  await writeDummyFile(
    worktree.worktreePath,
    worktree.filePath,
    buildDummyChangeContent(worktree.issueNumber, worktree.issueTitle, worktree.generatedAt),
  );
}

export async function commitAndPush(input: CommitAndPushInput): Promise<void> {
  const { worktree, commitMessage } = input;
  const { branchName, worktreePath } = worktree;
  await git(worktreePath, ['add', '--all']);
  await commitWorktreeIfNeeded(worktree, commitMessage);

  if (!(await hasCommitsToPush(worktree))) {
    throw new Error(`Agent produced no changes to push for branch ${branchName}.`);
  }

  await git(worktreePath, ['push', '-u', 'origin', branchName]);
}

export async function openPullRequest(input: OpenPullRequestInput): Promise<CreatedPullRequest> {
  const { worktree, title, body } = input;
  const existingPullRequest = await findOpenPullRequestForBranch(worktree);
  if (existingPullRequest) {
    return buildCreatedPullRequest(worktree, existingPullRequest);
  }

  return buildCreatedPullRequest(worktree, await createPullRequestWithDuplicateRecovery(worktree, title, body));
}

async function createPullRequestWithDuplicateRecovery(
  worktree: WorktreeContext,
  title?: string,
  body?: string,
): Promise<PullRequestResponse> {
  try {
    return await createPullRequest(worktree, title, body);
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

function buildCodexThreadOptions(worktreePath: string) {
  return {
    approvalPolicy: 'never' as const,
    model: CODEX_MODEL,
    modelReasoningEffort: CODEX_REASONING_EFFORT,
    sandboxMode: 'workspace-write' as const,
    workingDirectory: worktreePath,
  };
}

function buildAgentTurnOptions(): { signal?: AbortSignal } {
  const signal = getActivityCancellationSignal();
  return signal ? { signal } : {};
}

function createLazyCodexThread(factoryName: 'startThread' | 'resumeThread', factory: () => Promise<unknown>): AgentThread {
  let resolvedThread: { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> } | undefined;
  let threadPromise: Promise<{ id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> }> | undefined;

  const getThread = async () => {
    if (!threadPromise) {
      threadPromise = factory()
        .then((thread) => {
          const validatedThread = assertCodexThread(thread, factoryName);
          resolvedThread = validatedThread;
          return validatedThread;
        })
        .catch((error) => {
          threadPromise = undefined;
          throw error;
        });
    }

    return threadPromise;
  };

  return {
    get id() {
      if (!resolvedThread) {
        return null;
      }

      return readCodexThreadId(resolvedThread, factoryName);
    },
    async run(prompt, options) {
      const thread = await getThread();
      const turn = await thread.run(prompt, options);
      return {
        finalResponse: assertCodexTurnResult(turn, factoryName).finalResponse,
      };
    },
  };
}

function assertCodexThread(
  value: unknown,
  factoryName: 'startThread' | 'resumeThread',
): { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> } {
  if (!value || typeof value !== 'object' || typeof (value as { run?: unknown }).run !== 'function') {
    throw new Error(`Codex ${factoryName}() did not return a thread with a callable run() method.`);
  }

  return value as { id: unknown; run: (prompt: string, options?: unknown) => Promise<unknown> };
}

function readCodexThreadId(value: { id: unknown }, factoryName: 'startThread' | 'resumeThread'): string | null {
  if (value.id === undefined || value.id === null) {
    return null;
  }

  if (typeof value.id !== 'string') {
    throw new Error(`Codex ${factoryName}() returned a thread with a non-string id.`);
  }

  return value.id;
}

function assertCodexTurnResult(value: unknown, factoryName: 'startThread' | 'resumeThread'): AgentTurnResult {
  if (!value || typeof value !== 'object' || typeof (value as { finalResponse?: unknown }).finalResponse !== 'string') {
    throw new Error(`Codex ${factoryName}().run() did not return a finalResponse string.`);
  }

  return {
    finalResponse: (value as { finalResponse: string }).finalResponse,
  };
}

async function loadCodexSdk(): Promise<CodexSdkModule> {
  return (await dynamicImport('@openai/codex-sdk')) as CodexSdkModule;
}

async function runAgentSequenceSteps(worktree: WorktreeContext, steps: AgentStep[]): Promise<AgentSequenceResult> {
  assertUniqueStepIds(steps);
  const checkpoint = getCheckpoint();
  assertCheckpointMatchesStepSequence(checkpoint, steps);
  const completedStepIds = [...(checkpoint.completedStepIds ?? [])];
  const outputs = cloneAgentOutputs(checkpoint.outputs ?? {});
  let finalResponse = checkpoint.finalResponse;
  let threadId = checkpoint.threadId;

  if (checkpoint.pendingStep) {
    const resumedState = applyPendingStepCompletion(checkpoint.pendingStep, completedStepIds, outputs, finalResponse);
    finalResponse = resumedState.finalResponse;

    if (!threadId) {
      throw new Error(`Codex thread id was unavailable while finalizing step ${checkpoint.pendingStep.stepId}.`);
    }

    activityRuntime.heartbeat(
      buildCheckpointSnapshot({
        threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }),
    );
  }

  let thread: AgentThread | undefined;

  function getThread(): AgentThread {
    thread ??= threadId
      ? assertActivityThread(
          activityRuntime.resumeCodexThread(worktree.worktreePath, threadId),
          'resumeCodexThread',
        )
      : assertActivityThread(activityRuntime.createCodexThread(worktree.worktreePath), 'createCodexThread');
    return thread;
  }

  for (const step of steps) {
    if (completedStepIds.includes(step.id)) {
      continue;
    }

    const currentThread = getThread();
    let pendingStep: PendingStepCompletion;

    if (step.kind === 'prompt') {
      const turn = await runThreadTurnWithHeartbeat(currentThread, step.prompt, buildAgentTurnOptions(), () => ({
        threadId: currentThread.id ?? threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }));
      finalResponse = turn.finalResponse;
      pendingStep = buildPendingPromptStepCompletion(step, turn.finalResponse);
    } else {
      const { finalResponse: structuredResponse, parsedOutput } = await runStructuredStep(currentThread, step, () => ({
        threadId: currentThread.id ?? threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }));
      finalResponse = structuredResponse;
      pendingStep = buildPendingStructuredStepCompletion(step, structuredResponse, parsedOutput);
    }

    threadId = currentThread.id ?? threadId;
    if (!threadId) {
      throw new Error(`Codex thread id was unavailable after completing step ${step.id}.`);
    }

    activityRuntime.heartbeat(
      buildCheckpointSnapshot({
        threadId,
        completedStepIds,
        outputs,
        finalResponse,
        pendingStep,
      }),
    );
    finalResponse = applyPendingStepCompletion(pendingStep, completedStepIds, outputs, finalResponse).finalResponse;

    activityRuntime.heartbeat(
      buildCheckpointSnapshot({
        threadId,
        completedStepIds,
        outputs,
        finalResponse,
      }),
    );
  }

  if (!threadId) {
    throw new Error('Codex thread id was not available after running the agent sequence.');
  }

  return {
    threadId,
    completedStepIds: [...completedStepIds],
    outputs: { ...outputs },
    finalResponse,
  };
}

async function runStructuredStep(
  thread: AgentThread,
  step: Extract<AgentStep, { kind: 'structured' }>,
  getCheckpointDetails: () => AgentCheckpoint,
): Promise<{ finalResponse: string; parsedOutput?: unknown }> {
  const schemaDefinition = getAgentSchema(step.schemaId);
  const firstTurn = await runThreadTurnWithHeartbeat(
    thread,
    step.prompt,
    {
      ...buildAgentTurnOptions(),
      outputSchema: schemaDefinition.jsonSchema,
    },
    getCheckpointDetails,
  );
  const firstParsed = parseStructuredOutput(firstTurn.finalResponse, schemaDefinition.schema);
  if (firstParsed.success) {
    return { finalResponse: firstTurn.finalResponse, parsedOutput: firstParsed.parsedOutput };
  }

  const repairTurn = await runThreadTurnWithHeartbeat(
    thread,
    buildStructuredOutputRepairPrompt(step, firstTurn.finalResponse, firstParsed.errorMessage),
    {
      ...buildAgentTurnOptions(),
      outputSchema: schemaDefinition.jsonSchema,
    },
    getCheckpointDetails,
  );
  const repairParsed = parseStructuredOutput(repairTurn.finalResponse, schemaDefinition.schema);
  if (!repairParsed.success) {
    throw new Error(
      [
        `Structured output step ${step.id} did not satisfy schema ${step.schemaId}.`,
        `Initial parse failed: ${firstParsed.errorMessage}`,
        `Repair parse failed: ${repairParsed.errorMessage}`,
      ].join(' '),
    );
  }

  return {
    finalResponse: repairTurn.finalResponse,
    parsedOutput: repairParsed.parsedOutput,
  };
}

async function runThreadTurnWithHeartbeat(
  thread: AgentThread,
  prompt: string,
  options: { outputSchema?: unknown; signal?: AbortSignal } | undefined,
  getCheckpointDetails: () => AgentCheckpoint,
): Promise<AgentTurnResult> {
  let intervalError: unknown;
  activityRuntime.heartbeat(buildCheckpointSnapshot(getCheckpointDetails()));
  const interval = setInterval(() => {
    try {
      activityRuntime.heartbeat(buildCheckpointSnapshot(getCheckpointDetails()));
    } catch (error) {
      intervalError = error;
      clearInterval(interval);
    }
  }, AGENT_TURN_HEARTBEAT_INTERVAL_MS);

  interval.unref?.();

  try {
    const turn = await thread.run(prompt, options);
    if (intervalError) {
      throw intervalError;
    }

    return turn;
  } catch (runError) {
    if (intervalError) {
      throw intervalError;
    }

    activityRuntime.heartbeat(buildCheckpointSnapshot(getCheckpointDetails()));
    throw runError;
  } finally {
    clearInterval(interval);
  }
}

function parseStructuredOutput(
  finalResponse: string,
  schema: { parse: (value: unknown) => unknown },
): { success: true; parsedOutput: unknown } | { success: false; errorMessage: string } {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(finalResponse);
  } catch (error) {
    return {
      success: false,
      errorMessage: `Response was not valid JSON: ${toErrorMessage(error)}`,
    };
  }

  try {
    return {
      success: true,
      parsedOutput: schema.parse(parsedJson),
    };
  } catch (error) {
    return {
      success: false,
      errorMessage: `Response did not match the expected schema: ${toErrorMessage(error)}`,
    };
  }
}

function buildStructuredOutputRepairPrompt(
  step: Extract<AgentStep, { kind: 'structured' }>,
  invalidOutput: string,
  parseError: string,
): string {
  return [
    step.prompt,
    '',
    'The previous response did not satisfy the required structured output schema.',
    parseError,
    'Reply again using only data that conforms to the required schema.',
    '',
    'Previous invalid response:',
    invalidOutput,
  ].join('\n');
}

function getCheckpoint(): AgentCheckpoint {
  const heartbeatDetails = activityRuntime.getHeartbeatDetails();
  if (!heartbeatDetails || typeof heartbeatDetails !== 'object') {
    return {};
  }

  const checkpoint = heartbeatDetails as AgentCheckpoint & { pendingStructuredStep?: unknown };
  return {
    threadId: typeof checkpoint.threadId === 'string' ? checkpoint.threadId : undefined,
    completedStepIds: parseCompletedStepIds(checkpoint.completedStepIds),
    outputs: checkpoint.outputs && typeof checkpoint.outputs === 'object' ? cloneAgentOutputs(checkpoint.outputs) : {},
    finalResponse: typeof checkpoint.finalResponse === 'string' ? checkpoint.finalResponse : undefined,
    pendingStep:
      parsePendingStepCompletion(checkpoint.pendingStep) ??
      parseLegacyPendingStructuredStepCompletion(checkpoint.pendingStructuredStep),
  };
}

function buildCheckpointSnapshot(checkpoint: AgentCheckpoint): AgentCheckpoint {
  const snapshot: AgentCheckpoint = {
    completedStepIds: [...(checkpoint.completedStepIds ?? [])],
    outputs: cloneAgentOutputs(checkpoint.outputs ?? {}),
  };

  if (checkpoint.threadId) {
    snapshot.threadId = checkpoint.threadId;
  }

  if (checkpoint.finalResponse !== undefined) {
    snapshot.finalResponse = truncateCheckpointFinalResponse(checkpoint.finalResponse);
  }

  if (checkpoint.pendingStep) {
    snapshot.pendingStep = clonePendingStepCompletion(checkpoint.pendingStep);
  }

  return snapshot;
}

function buildPendingStructuredStepCompletion(
  step: Extract<AgentStep, { kind: 'structured' }>,
  finalResponse: string,
  parsedOutput: unknown,
): PendingStepCompletion {
  return {
    stepId: step.id,
    finalResponse,
    output: {
      resultKey: step.resultKey,
      parsedOutput: structuredClone(parsedOutput),
    },
  };
}

function buildPendingPromptStepCompletion(
  step: Extract<AgentStep, { kind: 'prompt' }>,
  finalResponse: string,
): PendingStepCompletion {
  return {
    stepId: step.id,
    finalResponse,
  };
}

function applyPendingStepCompletion(
  pendingStep: PendingStepCompletion,
  completedStepIds: string[],
  outputs: AgentSequenceResult['outputs'],
  fallbackFinalResponse: string | undefined,
): { finalResponse: string } {
  if (pendingStep.output) {
    outputs[pendingStep.output.resultKey] = structuredClone(pendingStep.output.parsedOutput);
  }

  if (!completedStepIds.includes(pendingStep.stepId)) {
    completedStepIds.push(pendingStep.stepId);
  }

  return {
    finalResponse: pendingStep.finalResponse ?? fallbackFinalResponse ?? '',
  };
}

function parsePendingStepCompletion(value: unknown): PendingStepCompletion | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pendingStep = value as Partial<PendingStepCompletion>;
  if (typeof pendingStep.stepId !== 'string' || typeof pendingStep.finalResponse !== 'string') {
    return undefined;
  }

  const output = parsePendingStepOutput(pendingStep.output);
  if (pendingStep.output && !output) {
    return undefined;
  }

  return clonePendingStepCompletion({
    stepId: pendingStep.stepId,
    finalResponse: pendingStep.finalResponse,
    output,
  });
}

function parseLegacyPendingStructuredStepCompletion(value: unknown): PendingStepCompletion | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pendingStructuredStep = value as {
    stepId?: unknown;
    resultKey?: unknown;
    parsedOutput?: unknown;
    finalResponse?: unknown;
  };
  if (
    typeof pendingStructuredStep.stepId !== 'string' ||
    !isAgentOutputKey(pendingStructuredStep.resultKey) ||
    typeof pendingStructuredStep.finalResponse !== 'string'
  ) {
    return undefined;
  }

  return {
    stepId: pendingStructuredStep.stepId,
    finalResponse: pendingStructuredStep.finalResponse,
    output: {
      resultKey: pendingStructuredStep.resultKey,
      parsedOutput: structuredClone(pendingStructuredStep.parsedOutput),
    },
  };
}

function parsePendingStepOutput(value: unknown): PendingStepCompletion['output'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const output = value as { resultKey?: unknown; parsedOutput?: unknown };
  if (!isAgentOutputKey(output.resultKey)) {
    return undefined;
  }

  return {
    resultKey: output.resultKey,
    parsedOutput: structuredClone(output.parsedOutput),
  };
}

function clonePendingStepCompletion(pendingStep: PendingStepCompletion): PendingStepCompletion {
  return {
    stepId: pendingStep.stepId,
    finalResponse: truncateCheckpointFinalResponse(pendingStep.finalResponse),
    ...(pendingStep.output
      ? {
          output: {
            resultKey: pendingStep.output.resultKey,
            parsedOutput: structuredClone(pendingStep.output.parsedOutput),
          },
        }
      : {}),
  };
}

function parseCompletedStepIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((stepId): stepId is string => typeof stepId === 'string');
}

function assertCheckpointMatchesStepSequence(checkpoint: AgentCheckpoint, steps: AgentStep[]): void {
  const validStepIds = new Set(steps.map((step) => step.id));
  const staleCompletedStepIds = (checkpoint.completedStepIds ?? []).filter((stepId) => !validStepIds.has(stepId));
  if (staleCompletedStepIds.length > 0) {
    throw new Error(
      `Heartbeat checkpoint contains stale completed step ids that do not exist in the current agent sequence: ${staleCompletedStepIds.join(', ')}`,
    );
  }

  if (checkpoint.pendingStep && !validStepIds.has(checkpoint.pendingStep.stepId)) {
    throw new Error(
      `Heartbeat checkpoint contains a stale pending step id that does not exist in the current agent sequence: ${checkpoint.pendingStep.stepId}`,
    );
  }
}

function truncateCheckpointFinalResponse(finalResponse: string): string {
  if (Buffer.byteLength(finalResponse, 'utf8') <= MAX_CHECKPOINT_FINAL_RESPONSE_BYTES) {
    return finalResponse;
  }

  const suffixBytes = Buffer.byteLength(CHECKPOINT_TRUNCATION_SUFFIX, 'utf8');
  const contentBudget = MAX_CHECKPOINT_FINAL_RESPONSE_BYTES - suffixBytes;
  if (contentBudget <= 0) {
    return CHECKPOINT_TRUNCATION_SUFFIX;
  }

  let low = 0;
  let high = finalResponse.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(finalResponse.slice(0, mid), 'utf8') <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${finalResponse.slice(0, low)}${CHECKPOINT_TRUNCATION_SUFFIX}`;
}

function assertUniqueStepIds(steps: AgentStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`Agent step sequences must use unique step ids. Duplicate id: ${step.id}`);
    }

    seen.add(step.id);
  }
}

function assertActivityThread(value: unknown, methodName: 'createCodexThread' | 'resumeCodexThread'): AgentThread {
  if (!value || typeof value !== 'object' || typeof (value as { run?: unknown }).run !== 'function') {
    throw new Error(`Activity runtime ${methodName}() did not return an agent thread with a callable run() method.`);
  }

  const threadId = (value as { id?: unknown }).id;
  if (!(threadId === undefined || threadId === null || typeof threadId === 'string')) {
    throw new Error(`Activity runtime ${methodName}() returned an agent thread with a non-string id.`);
  }

  return value as AgentThread;
}

function isAgentOutputKey(value: unknown): value is AgentOutputKey {
  return typeof value === 'string' && (AGENT_OUTPUT_KEYS as readonly string[]).includes(value);
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
  return execCommand(CODEX_COMMAND, buildCodexArgs(prompt), { cwd, ...buildAgentTurnOptions() });
}

function cloneAgentOutputs(outputs: AgentSequenceResult['outputs']): AgentSequenceResult['outputs'] {
  return structuredClone(outputs);
}

function getActivityHeartbeatDetails(): unknown {
  const context = getCurrentActivityContextOrUndefined();
  return context?.info.heartbeatDetails;
}

function heartbeatActivity(details: unknown): void {
  const context = getCurrentActivityContextOrUndefined();
  if (!context) {
    return;
  }

  context.heartbeat(details);
}

function getActivityCancellationSignal(): AbortSignal | undefined {
  const context = getCurrentActivityContextOrUndefined();
  return context?.cancellationSignal;
}

function getCurrentActivityContextOrUndefined(): ReturnType<typeof Context.current> | undefined {
  try {
    return Context.current();
  } catch (error) {
    if (isMissingActivityContextError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingActivityContextError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Activity context not initialized';
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

async function commitWorktreeIfNeeded(worktree: WorktreeContext, commitMessage?: string): Promise<void> {
  if (!(await hasStagedChanges(worktree.worktreePath))) {
    return;
  }

  await git(worktree.worktreePath, ['commit', '-m', buildCommitMessage(worktree, commitMessage)]);
}

async function hasCommitsToPush(worktree: WorktreeContext): Promise<boolean> {
  const baseRef = (await hasRemoteBranch(worktree.repoRoot, worktree.branchName))
    ? `origin/${worktree.branchName}`
    : `origin/${worktree.defaultBranch}`;

  return hasAheadCommits(worktree.worktreePath, baseRef);
}

async function hasAheadCommits(worktreePath: string, baseRef: string): Promise<boolean> {
  const result = await git(worktreePath, ['rev-list', '--count', `${baseRef}..HEAD`]);
  const commitCount = Number.parseInt(result.stdout.trim(), 10);

  if (Number.isNaN(commitCount)) {
    throw new Error(`Could not determine whether HEAD is ahead of ${baseRef}.`);
  }

  return commitCount > 0;
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

async function createPullRequest(worktree: WorktreeContext, title?: string, body?: string): Promise<PullRequestResponse> {
  const repoPath = buildRepoApiPath(worktree.repoOwner, worktree.repoName);

  return githubRest<PullRequestResponse>(`${repoPath}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: buildPullRequestTitle(worktree, title),
      head: worktree.branchName,
      base: worktree.defaultBranch,
      body: buildPullRequestBody(worktree, body),
    }),
  });
}

function buildCommitMessage(worktree: WorktreeContext, commitMessage?: string): string {
  return commitMessage?.trim() || `Add dummy change for issue #${worktree.issueNumber}`;
}

function buildPullRequestTitle(worktree: WorktreeContext, title?: string): string {
  return title?.trim() || `chore: dummy change for #${worktree.issueNumber}`;
}

function buildPullRequestBody(worktree: WorktreeContext, body?: string): string {
  return body?.trim() || `Automated dummy change for ${worktree.issueUrl}`;
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

  if (!text) {
    throw new Error('GitHub request succeeded but returned an empty response body.');
  }

  return JSON.parse(text) as T;
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
    signal: options.signal,
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