import assert from 'assert';
import { buildBranchName } from '../../orchestrator/lib/activities';
import type { GitHubClientDeps } from '../../orchestrator/lib/activity-deps';
import { buildNightShiftMarker } from '../../orchestrator/lib/activity-github';
import { buildRepoApiPath, githubGraphql, githubRest } from '../../orchestrator/lib/activity-github-client';
import { createGitHubActivities } from '../../orchestrator/lib/activity-github';
import { DEFAULT_BACKLOG_STATUS, DEFAULT_READY_STATUS, type AutomateReadyIssueResult, type SelectedProjectIssue, type WorkflowPhase } from '../../orchestrator/lib/shared';
import type { E2EConfig } from './config';
import { FAKE_AGENT_FILE_PATH, buildFakeAgentFileText } from './fake-agent';

const PROJECT_STATUS_FIELD_NAME = 'Status';
const GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_SELECTION_MAX_ATTEMPTS = 10;
const DEFAULT_SELECTION_RETRY_DELAY_MS = 1_000;
const GITHUB_JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

interface IssueCreateResponse {
  number: number;
  html_url: string;
  node_id: string;
}

interface AddProjectItemMutationData {
  addProjectV2ItemById: {
    item: {
      id: string;
    };
  };
}

interface ExistingProjectItemQueryData {
  node: null | {
    __typename: 'Issue';
    projectItems: {
      nodes: Array<{ id: string; project: { id: string } }>;
    };
  };
}

interface ProjectItemStatusQueryData {
  node: null | {
    __typename: 'ProjectV2Item';
    fieldValueByName:
      | null
      | {
          __typename: 'ProjectV2ItemFieldSingleSelectValue';
          name: string;
        };
  };
}

interface PullRequestDetails {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: string;
  head: {
    ref: string;
    sha: string;
  };
}

interface IssueCommentResponse {
  body: string;
}

interface CommitResponse {
  commit: {
    message: string;
  };
}

interface RepoContentResponse {
  content: string;
  encoding: string;
}

interface SelectionRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

interface FakeArtifactsSnapshot {
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  implementSummaryCommentBody: string;
  reviewSummaryCommentBody: string;
  fileText: string;
}

export interface SeededIssue {
  runId: string;
  issueNumber: number;
  issueUrl: string;
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
}

export interface CleanupReport {
  attempted: string[];
  failures: Array<{ step: string; error: string }>;
}

const ADD_PROJECT_ITEM_MUTATION = `
  mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item {
        id
      }
    }
  }
`;

const EXISTING_PROJECT_ITEM_QUERY = `
  query ExistingProjectItem($contentId: ID!) {
    node(id: $contentId) {
      __typename
      ... on Issue {
        projectItems(first: 20) {
          nodes {
            id
            project { id }
          }
        }
      }
    }
  }
`;

const UPDATE_PROJECT_ITEM_STATUS_MUTATION = `
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

const DELETE_PROJECT_ITEM_MUTATION = `
  mutation DeleteProjectItem($projectId: ID!, $itemId: ID!) {
    deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
      deletedItemId
    }
  }
`;

const PROJECT_ITEM_STATUS_QUERY = `
  query ProjectItemStatus($itemId: ID!) {
    node(id: $itemId) {
      __typename
      ... on ProjectV2Item {
        fieldValueByName(name: "${PROJECT_STATUS_FIELD_NAME}") {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
          }
        }
      }
    }
  }
`;

export function createGitHubDeps(githubToken: string): GitHubClientDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
    getGitHubToken: () => githubToken,
  };
}

export async function seedIssueInProject(
  deps: GitHubClientDeps,
  config: E2EConfig,
  runId: string,
  title: string,
  body: string,
  initialStatusName = DEFAULT_READY_STATUS,
): Promise<SeededIssue> {
  const issue = await createIssue(deps, config, title, body);
  const projectStatus = await createGitHubActivities(deps).ensureProjectStatusOptions({
    projectOwner: config.projectOwner,
    projectNumber: config.projectNumber,
  });
  const projectItemId = await addIssueToProject(deps, projectStatus.projectId, issue.node_id);
  await updateProjectItemStatus(
    deps,
    projectStatus.projectId,
    projectItemId,
    projectStatus.statusFieldId,
    projectStatus.statusOptionIds[initialStatusName as keyof typeof projectStatus.statusOptionIds],
  );

  return {
    runId,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    projectId: projectStatus.projectId,
    projectItemId,
    statusFieldId: projectStatus.statusFieldId,
  };
}

export async function getProjectItemStatusName(
  deps: GitHubClientDeps,
  itemId: string,
): Promise<string | undefined> {
  const data = await githubGraphql<ProjectItemStatusQueryData>(deps, PROJECT_ITEM_STATUS_QUERY, { itemId });
  return data.node?.fieldValueByName?.__typename === 'ProjectV2ItemFieldSingleSelectValue'
    ? data.node.fieldValueByName.name
    : undefined;
}

export async function assertSeededIssueWillBeSelected(
  deps: GitHubClientDeps,
  config: E2EConfig,
  expectedIssueNumber: number,
  startPhaseOrOptions: WorkflowPhase | SelectionRetryOptions = 'implement',
  maybeOptions: SelectionRetryOptions = {},
): Promise<SelectedProjectIssue> {
  const startPhase = typeof startPhaseOrOptions === 'string' ? startPhaseOrOptions : 'implement';
  const options = typeof startPhaseOrOptions === 'string' ? maybeOptions : startPhaseOrOptions;
  const maxAttempts = options.maxAttempts ?? DEFAULT_SELECTION_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_SELECTION_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const selectedIssue = await (startPhase === 'specify'
        ? createGitHubActivities(deps).getTopBacklogIssue({
            projectOwner: config.projectOwner,
            projectNumber: config.projectNumber,
            backlogStatusName: DEFAULT_BACKLOG_STATUS,
          })
        : createGitHubActivities(deps).getTopReadyIssue({
        projectOwner: config.projectOwner,
        projectNumber: config.projectNumber,
      }));

      if (selectedIssue.issueNumber === expectedIssueNumber) {
        return selectedIssue;
      }

      lastError = createUnexpectedSelectionError(expectedIssueNumber, selectedIssue.issueNumber);
    } catch (error) {
      lastError = error;
      if (!isRetryableProjectSelectionError(error)) {
        throw error;
      }
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function assertWorkflowArtifacts(
  deps: GitHubClientDeps,
  config: E2EConfig,
  seededIssue: SeededIssue,
  selectedIssue: SelectedProjectIssue,
  workflowResult: AutomateReadyIssueResult,
): Promise<void> {
  assert.strictEqual(workflowResult.issueNumber, seededIssue.issueNumber);
  assert.strictEqual(workflowResult.issueUrl, seededIssue.issueUrl);

  const pullRequest = await getPullRequest(deps, selectedIssue.repoOwner, selectedIssue.repoName, workflowResult.pullRequestNumber);
  const commit = await getCommit(deps, selectedIssue.repoOwner, selectedIssue.repoName, pullRequest.head.sha);
  const comments = await getIssueComments(deps, selectedIssue.repoOwner, selectedIssue.repoName, selectedIssue.issueNumber);

  assertCommonWorkflowArtifacts(pullRequest, comments, workflowResult);

  if (config.agentMode === 'fake') {
    await assertFakeAgentArtifacts(deps, seededIssue, selectedIssue, workflowResult, pullRequest, commit);
    return;
  }

  assertRealAgentArtifacts(pullRequest, commit, seededIssue, selectedIssue);
}

export async function cleanupRunArtifacts(
  deps: GitHubClientDeps,
  config: E2EConfig,
  seededIssue: SeededIssue,
  selectedIssue: SelectedProjectIssue | undefined,
  branchPrefix: string,
  workflowResult?: AutomateReadyIssueResult,
): Promise<CleanupReport> {
  const report: CleanupReport = { attempted: [], failures: [] };
  const repoOwner = selectedIssue?.repoOwner ?? config.targetRepo.owner;
  const repoName = selectedIssue?.repoName ?? config.targetRepo.name;
  const branchName = resolveCleanupBranchName(selectedIssue, branchPrefix, workflowResult);

  if (workflowResult?.pullRequestNumber) {
    await attemptCleanupStep(report, 'closePullRequest', async () => {
      await githubRest(deps, `${buildRepoApiPath(repoOwner, repoName)}/pulls/${workflowResult.pullRequestNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
    });
  }

  await attemptCleanupStep(report, 'closeIssue', async () => {
    await githubRest(deps, `${buildRepoApiPath(config.targetRepo.owner, config.targetRepo.name)}/issues/${seededIssue.issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  });

  await attemptCleanupStep(report, 'deleteProjectItem', async () => {
    await githubGraphql(deps, DELETE_PROJECT_ITEM_MUTATION, {
      projectId: seededIssue.projectId,
      itemId: seededIssue.projectItemId,
    });
  });

  if (branchName) {
    await attemptCleanupStep(report, 'deleteBranch', async () => {
      await githubRestAllowEmptySuccess(
        deps,
        `${buildRepoApiPath(repoOwner, repoName)}/git/refs/heads/${encodeURIComponent(branchName)}`,
        { method: 'DELETE' },
      );
    });
  }

  return report;
}

export function buildSelectedIssueChangeName(issue: SelectedProjectIssue): string {
  const slug = issue.issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'change';
  return `${issue.issueNumber}-${slug}`;
}

async function createIssue(
  deps: GitHubClientDeps,
  config: E2EConfig,
  title: string,
  body: string,
): Promise<IssueCreateResponse> {
  return githubRest(deps, `${buildRepoApiPath(config.targetRepo.owner, config.targetRepo.name)}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  });
}

function assertCommonWorkflowArtifacts(
  pullRequest: PullRequestDetails,
  comments: IssueCommentResponse[],
  workflowResult: AutomateReadyIssueResult,
): void {
  assert.strictEqual(pullRequest.html_url, workflowResult.pullRequestUrl);
  assert.strictEqual(pullRequest.head.ref, workflowResult.branchName);
  assert.ok(
    comments.some((comment) => comment.body.includes(buildNightShiftMarker('implement:summary'))),
    'Expected the seeded issue to contain the implement summary marker comment.',
  );
  assert.ok(
    comments.some((comment) => comment.body.includes(buildNightShiftMarker('review:summary'))),
    'Expected the seeded issue to contain the review summary marker comment.',
  );
}

async function assertFakeAgentArtifacts(
  deps: GitHubClientDeps,
  seededIssue: SeededIssue,
  selectedIssue: SelectedProjectIssue,
  workflowResult: AutomateReadyIssueResult,
  pullRequest: PullRequestDetails,
  commit: CommitResponse,
): Promise<void> {
  const fileText = await getFileTextAtRef(
    deps,
    selectedIssue.repoOwner,
    selectedIssue.repoName,
    FAKE_AGENT_FILE_PATH,
    workflowResult.branchName,
  );

  const actualArtifacts: FakeArtifactsSnapshot = {
    commitMessage: commit.commit.message,
    pullRequestTitle: pullRequest.title,
    pullRequestBody: pullRequest.body,
    implementSummaryCommentBody: getRequiredSummaryComment(commentsForMarker('implement:summary', await getIssueComments(deps, selectedIssue.repoOwner, selectedIssue.repoName, selectedIssue.issueNumber))),
    reviewSummaryCommentBody: getRequiredSummaryComment(commentsForMarker('review:summary', await getIssueComments(deps, selectedIssue.repoOwner, selectedIssue.repoName, selectedIssue.issueNumber))),
    fileText,
  };

  assert.deepStrictEqual(actualArtifacts, getExpectedFakeArtifacts(seededIssue.runId, selectedIssue, workflowResult.pullRequestUrl));
}

function assertRealAgentArtifacts(
  pullRequest: PullRequestDetails,
  commit: CommitResponse,
  seededIssue: SeededIssue,
  selectedIssue: SelectedProjectIssue,
): void {
  assert.ok(pullRequest.title.trim(), 'Expected a non-empty pull request title.');
  assert.ok(pullRequest.body.trim(), 'Expected a non-empty pull request body.');
  assert.ok(commit.commit.message.trim(), 'Expected a non-empty commit message.');

  const linkageText = [pullRequest.title, pullRequest.body, commit.commit.message].join('\n');
  const linkageCandidates = [seededIssue.runId, `#${selectedIssue.issueNumber}`, seededIssue.issueUrl];
  assert.ok(
    linkageCandidates.some((candidate) => linkageText.includes(candidate)),
    'Expected real-agent metadata to contain the run marker, issue number, or issue URL.',
  );
}

function getExpectedFakeArtifacts(runId: string, selectedIssue: SelectedProjectIssue, pullRequestUrl: string): FakeArtifactsSnapshot {
  return {
    commitMessage: `test: fake e2e change for ${runId}`,
    pullRequestTitle: `#${selectedIssue.issueNumber}: ${selectedIssue.issueTitle}`,
    pullRequestBody: [
      `Closes ${selectedIssue.issueUrl}`,
      '',
      '> Generated by the Night Shift Implement phase.',
      '',
      '## Summary',
      `Deterministic fake e2e change for ${runId}.`,
      '',
      '## Follow-ups',
      `- Run marker: ${runId}`,
    ].join('\n'),
    implementSummaryCommentBody: [
      `## Implement summary for #${selectedIssue.issueNumber}`,
      `- Change: \`openspec/changes/${buildSelectedIssueChangeName(selectedIssue)}\``,
      `- Summary: Deterministic fake e2e change for ${runId}.`,
      `- Follow-ups: Run marker: ${runId}`,
      '- Quality gate: make check passed',
    ].join('\n'),
    reviewSummaryCommentBody: [
      `## Review summary for #${selectedIssue.issueNumber}`,
      `- Change: \`openspec/changes/${buildSelectedIssueChangeName(selectedIssue)}\``,
      `- Pull request: ${pullRequestUrl}`,
      '- Verdict: ready-to-merge',
      '- Iteration: 2',
      `- Summary: Review looks good for ${runId} after one rerun.`,
      `- Findings: warning: Run marker ${runId} is embedded in the fake E2E artifact for traceability. (${FAKE_AGENT_FILE_PATH}:3)`,
    ].join('\n'),
    fileText: buildFakeAgentFileText(runId),
  };
}

function commentsForMarker(marker: string, comments: IssueCommentResponse[]): string[] {
  const markerText = buildNightShiftMarker(marker);
  return comments.filter((comment) => comment.body.includes(markerText)).map((comment) => comment.body.replace(`${markerText}\n`, ''));
}

function getRequiredSummaryComment(comments: string[]): string {
  assert.strictEqual(comments.length > 0, true, 'Expected an implement summary comment.');
  return comments[0];
}

function resolveCleanupBranchName(
  selectedIssue: SelectedProjectIssue | undefined,
  branchPrefix: string,
  workflowResult?: AutomateReadyIssueResult,
): string | undefined {
  if (workflowResult?.branchName) {
    return workflowResult.branchName;
  }
  if (!selectedIssue) {
    return undefined;
  }
  return buildBranchName(selectedIssue.issueNumber, branchPrefix);
}

async function addIssueToProject(
  deps: GitHubClientDeps,
  projectId: string,
  issueNodeId: string,
): Promise<string> {
  try {
    const data = await githubGraphql<AddProjectItemMutationData>(deps, ADD_PROJECT_ITEM_MUTATION, {
      projectId,
      contentId: issueNodeId,
    });
    return data.addProjectV2ItemById.item.id;
  } catch (error) {
    if (!isDuplicateProjectItemError(error)) throw error;
    const existingItemId = await findExistingProjectItemId(deps, projectId, issueNodeId);
    if (existingItemId) return existingItemId;
    throw error;
  }
}

async function findExistingProjectItemId(
  deps: GitHubClientDeps,
  projectId: string,
  issueNodeId: string,
): Promise<string | undefined> {
  const data = await githubGraphql<ExistingProjectItemQueryData>(deps, EXISTING_PROJECT_ITEM_QUERY, { contentId: issueNodeId });
  if (data.node?.__typename !== 'Issue') return undefined;
  return data.node.projectItems.nodes.find((item) => item.project.id === projectId)?.id;
}

async function updateProjectItemStatus(
  deps: GitHubClientDeps,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await githubGraphql(deps, UPDATE_PROJECT_ITEM_STATUS_MUTATION, {
    projectId,
    itemId,
    fieldId,
    optionId,
  });
}

async function getPullRequest(
  deps: GitHubClientDeps,
  repoOwner: string,
  repoName: string,
  pullRequestNumber: number,
): Promise<PullRequestDetails> {
  return githubRest(deps, `${buildRepoApiPath(repoOwner, repoName)}/pulls/${pullRequestNumber}`);
}

async function getCommit(
  deps: GitHubClientDeps,
  repoOwner: string,
  repoName: string,
  sha: string,
): Promise<CommitResponse> {
  return githubRest(deps, `${buildRepoApiPath(repoOwner, repoName)}/commits/${sha}`);
}

async function getIssueComments(
  deps: GitHubClientDeps,
  repoOwner: string,
  repoName: string,
  issueNumber: number,
): Promise<IssueCommentResponse[]> {
  return githubRest(deps, `${buildRepoApiPath(repoOwner, repoName)}/issues/${issueNumber}/comments`);
}

async function getFileTextAtRef(
  deps: GitHubClientDeps,
  repoOwner: string,
  repoName: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const response = await githubRest<RepoContentResponse>(
    deps,
    `${buildRepoApiPath(repoOwner, repoName)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
  );
  if (response.encoding !== 'base64') {
    throw new Error(`Expected GitHub contents API to return base64 encoding for ${filePath}.`);
  }
  return Buffer.from(response.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function attemptCleanupStep(
  report: CleanupReport,
  step: string,
  action: () => Promise<void>,
): Promise<void> {
  report.attempted.push(step);
  try {
    await action();
  } catch (error) {
    if (isGitHubNotFoundError(error)) {
      return;
    }
    report.failures.push({ step, error: formatUnknownError(error) });
  }
}

function isGitHubNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('GitHub request failed (404 Not Found)');
}

function isDuplicateProjectItemError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Content already exists in this project');
}

async function githubRestAllowEmptySuccess(
  deps: GitHubClientDeps,
  path: string,
  init: RequestInit,
): Promise<void> {
  const response = await deps.fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${deps.getGitHubToken()}`, ...GITHUB_JSON_HEADERS, ...init.headers },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status} ${response.statusText}): ${text}`);
  }
}

function isRetryableProjectSelectionError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.includes('Could not find a Ready issue in GitHub Project')
      || error.message.includes('Could not find a Backlog issue in GitHub Project'));
}

function createUnexpectedSelectionError(expectedIssueNumber: number, actualIssueNumber: number): Error {
  return new Error(
    `Seeded issue #${expectedIssueNumber} is not the current top Ready issue; workflow would select #${actualIssueNumber} instead.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}