import {
  CANONICAL_PROJECT_STATUS_NAMES,
  DEFAULT_BACKLOG_STATUS,
  DEFAULT_BLOCKED_STATUS,
  DEFAULT_ESCALATED_STATUS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_REFINED_STATUS,
  DEFAULT_REFINEMENT_STATUS,
  DEFAULT_READY_STATUS,
  type AutomateReadyIssueInput,
  type EnsureProjectStatusOptionsInput,
  type ListedProjectIssue,
  type ListProjectIssuesByStatusInput,
  type MoveProjectItemStatusInput,
  type ProjectStatusName,
  type ResolvedProjectStatusOptions,
  type SelectedProjectIssue,
} from './shared';
import type { GitHubActivityDeps } from './activity-deps';
import { githubGraphql, isMissingProjectOwnerError } from './activity-github-client';

const PROJECT_STATUS_FIELD_NAME = 'Status';
const PROJECT_ITEMS_FIRST = 100;

interface ProjectQueryData {
  owner: ProjectOwner | null;
}

interface ProjectOwner {
  projectV2: ProjectData | null;
}

interface ProjectData {
  id: string;
  fields: { nodes: ProjectFieldNode[] };
  items: { nodes: ProjectItemNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

type ProjectFieldNode =
  | {
      __typename: 'ProjectV2SingleSelectField';
      id: string;
      name: string;
      options: Array<{ id: string; name: string; color?: string; description?: string | null }>;
    }
  | { __typename: string };

interface ProjectItemNode {
  id: string;
  fieldValueByName: null | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; name: string };
  content:
    | null
    | {
        __typename: 'Issue';
        number: number;
        title: string;
        body: string;
        url: string;
        createdAt: string;
        labels?: { nodes: Array<{ name: string }> };
        repository: { name: string; owner: { login: string }; defaultBranchRef: null | { name: string } };
      }
    | { __typename: string };
}

type ProjectSingleSelectField = Extract<ProjectFieldNode, { __typename: 'ProjectV2SingleSelectField' }>;
type ProjectIssueContent = Extract<NonNullable<ProjectItemNode['content']>, { __typename: 'Issue' }>;
type ProjectStatusOption = ProjectSingleSelectField['options'][number];
type ReadyProjectItem = ProjectItemNode & { content: ProjectIssueContent };
type ProjectStatusField = Pick<ProjectSingleSelectField, 'id' | 'options'>;

interface UpdateStatusFieldMutationData {
  updateProjectV2Field: {
    projectV2Field: {
      id: string;
      options: ProjectStatusOption[];
    };
  };
}

interface ResolvedStatusField extends ProjectStatusField {
  statusOptionIds: Record<ProjectStatusName, string>;
}

const PROJECT_STATUS_COLORS: Record<ProjectStatusName, string> = {
  Backlog: 'GRAY',
  Refinement: 'BLUE',
  Refined: 'BLUE',
  Ready: 'GREEN',
  'In progress': 'YELLOW',
  'In review': 'PURPLE',
  'Ready to merge': 'GREEN',
  Escalated: 'ORANGE',
  Blocked: 'RED',
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
            color
            description
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
            createdAt
            labels(first: 20) {
              nodes {
                name
              }
            }
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

const UPDATE_STATUS_FIELD_MUTATION = `
  mutation UpdateStatusField($input: UpdateProjectV2FieldInput!) {
    updateProjectV2Field(input: $input) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
            color
            description
          }
        }
      }
    }
  }
`;

export async function ensureProjectStatusOptionsActivity(
  deps: GitHubActivityDeps,
  input: EnsureProjectStatusOptionsInput,
): Promise<ResolvedProjectStatusOptions> {
  const project = await lookupProject(deps, input.projectOwner, input.projectNumber);
  const statusField = await ensureCanonicalProjectStatusOptions(deps, getProjectStatusField(project));
  return {
    projectId: project.id,
    statusFieldId: statusField.id,
    statusOptionIds: statusField.statusOptionIds,
  };
}

export async function getTopReadyIssueActivity(
  deps: GitHubActivityDeps,
  input: AutomateReadyIssueInput,
): Promise<SelectedProjectIssue> {
  return getTopProjectIssueForStatusActivity(deps, input, input.readyStatusName ?? DEFAULT_READY_STATUS);
}

export async function getTopBacklogIssueActivity(
  deps: GitHubActivityDeps,
  input: AutomateReadyIssueInput,
): Promise<SelectedProjectIssue> {
  return getTopProjectIssueForStatusActivity(deps, input, input.backlogStatusName ?? DEFAULT_BACKLOG_STATUS);
}

export async function listProjectIssuesByStatusActivity(
  deps: GitHubActivityDeps,
  input: ListProjectIssuesByStatusInput,
): Promise<ListedProjectIssue[]> {
  const project = await lookupProject(deps, input.projectOwner, input.projectNumber);
  const statusField = await ensureCanonicalProjectStatusOptions(deps, getProjectStatusField(project));
  return listProjectIssuesForStatuses(project, statusField, input, input.statusNames);
}

export async function moveProjectItemStatusActivity(
  deps: GitHubActivityDeps,
  input: MoveProjectItemStatusInput,
): Promise<void> {
  await githubGraphql(deps, MOVE_PROJECT_ITEM_MUTATION, {
    projectId: input.projectId,
    itemId: input.projectItemId,
    fieldId: input.statusFieldId,
    optionId: input.statusOptionId,
  });
}

async function lookupProject(deps: GitHubActivityDeps, projectOwner: string, projectNumber: number): Promise<ProjectData> {
  const variables = { login: projectOwner, number: projectNumber, itemsFirst: PROJECT_ITEMS_FIRST, itemsAfter: null };
  const userOwner = await lookupProjectOwner(deps, USER_PROJECT_QUERY, variables, 'User');
  if (userOwner?.projectV2) {
    return paginateProjectItems(deps, USER_PROJECT_QUERY, variables, 'User', userOwner.projectV2);
  }
  if (userOwner) {
    throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
  }

  const organizationOwner = await lookupProjectOwner(deps, ORGANIZATION_PROJECT_QUERY, variables, 'Organization');
  if (organizationOwner?.projectV2) {
    return paginateProjectItems(deps, ORGANIZATION_PROJECT_QUERY, variables, 'Organization', organizationOwner.projectV2);
  }

  throw new Error(`Could not find GitHub Project ${projectOwner}/${projectNumber}.`);
}

async function paginateProjectItems(
  deps: GitHubActivityDeps,
  query: string,
  variables: { login: string; number: number; itemsFirst: number; itemsAfter: string | null },
  ownerType: 'User' | 'Organization',
  firstPageProject: ProjectData,
): Promise<ProjectData> {
  const project: ProjectData = {
    ...firstPageProject,
    fields: { nodes: [...firstPageProject.fields.nodes] },
    items: { nodes: [...firstPageProject.items.nodes], pageInfo: { ...firstPageProject.items.pageInfo } },
  };

  while (project.items.pageInfo.hasNextPage) {
    const nextCursor = project.items.pageInfo.endCursor;
    const owner = await lookupProjectOwner(deps, query, { ...variables, itemsAfter: nextCursor }, ownerType);
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
  deps: GitHubActivityDeps,
  query: string,
  variables: Record<string, unknown>,
  ownerType: 'User' | 'Organization',
): Promise<ProjectOwner | null> {
  try {
    const data = await githubGraphql<ProjectQueryData>(deps, query, variables);
    return data.owner;
  } catch (error) {
    if (isMissingProjectOwnerError(error, ownerType)) {
      return null;
    }
    throw error;
  }
}

async function ensureCanonicalProjectStatusOptions(
  deps: GitHubActivityDeps,
  statusField: ProjectStatusField,
): Promise<ResolvedStatusField> {
  const statusOptionIds = buildProjectStatusOptionIds(statusField.options);
  const missingStatusNames = CANONICAL_PROJECT_STATUS_NAMES.filter((statusName) => !statusOptionIds[statusName]);
  if (missingStatusNames.length === 0) {
    return {
      id: statusField.id,
      options: statusField.options,
      statusOptionIds: statusOptionIds as Record<ProjectStatusName, string>,
    };
  }

  const updatedField = await githubGraphql<UpdateStatusFieldMutationData>(deps, UPDATE_STATUS_FIELD_MUTATION, {
    input: {
      fieldId: statusField.id,
      singleSelectOptions: buildStatusFieldUpdateOptions(statusField.options, missingStatusNames),
    },
  });

  return buildResolvedStatusField(updatedField.updateProjectV2Field.projectV2Field);
}

function getProjectStatusField(project: ProjectData): ProjectStatusField {
  const statusField = project.fields.nodes.find(
    (field): field is ProjectSingleSelectField => isProjectSingleSelectField(field) && field.name === PROJECT_STATUS_FIELD_NAME,
  );
  if (!statusField) {
    throw new Error('The GitHub Project does not contain a Status field.');
  }
  return { id: statusField.id, options: statusField.options };
}

function getRequiredStatusOption(statusField: ProjectStatusField, statusName: string): ProjectStatusOption {
  const statusOption = findStatusOption(statusField, statusName);
  if (!statusOption) {
    throw new Error(`Could not find the ${statusName} status option on the GitHub Project.`);
  }
  return statusOption;
}

function findStatusOption(statusField: ProjectStatusField, statusName: string): ProjectStatusOption | undefined {
  return statusField.options.find((option) => option.name === statusName);
}

function buildProjectStatusOptionIds(
  options: readonly ProjectStatusOption[],
): Partial<Record<ProjectStatusName, string>> {
  const optionIds: Partial<Record<ProjectStatusName, string>> = {};
  for (const option of options) {
    if (!isProjectStatusName(option.name)) continue;
    optionIds[option.name] = option.id;
  }
  return optionIds;
}

function buildStatusFieldUpdateOptions(
  options: readonly ProjectStatusOption[],
  missingStatusNames: readonly ProjectStatusName[],
): Array<{ name: string; color: string; description: string }> {
  const existingOptionsByName = new Map(options.map((option) => [option.name, option]));
  const customOptionNames = options
    .map((option) => option.name)
    .filter((optionName) => !isProjectStatusName(optionName));

  return [
    ...CANONICAL_PROJECT_STATUS_NAMES.filter(
      (statusName) => existingOptionsByName.has(statusName) || missingStatusNames.includes(statusName),
    ).map((statusName) => {
      const existingOption = existingOptionsByName.get(statusName);
      return {
        name: statusName,
        color: existingOption?.color ?? PROJECT_STATUS_COLORS[statusName],
        description:
          existingOption?.description ??
          (missingStatusNames.includes(statusName) ? `orchestrator auto-created status: ${statusName}` : ''),
      };
    }),
    ...customOptionNames.map((name) => {
      const existingOption = existingOptionsByName.get(name);
      return {
        name,
        color: existingOption?.color ?? 'GRAY',
        description: existingOption?.description ?? '',
      };
    }),
  ];
}

function buildResolvedStatusField(statusField: ProjectStatusField): ResolvedStatusField {
  const statusOptionIds = buildProjectStatusOptionIds(statusField.options);
  const missingStatusNames = CANONICAL_PROJECT_STATUS_NAMES.filter((statusName) => !statusOptionIds[statusName]);
  if (missingStatusNames.length > 0) {
    throw new Error(`Could not ensure the GitHub Project statuses: ${missingStatusNames.join(', ')}.`);
  }
  return {
    id: statusField.id,
    options: statusField.options,
    statusOptionIds: statusOptionIds as Record<ProjectStatusName, string>,
  };
}

async function getTopProjectIssueForStatusActivity(
  deps: GitHubActivityDeps,
  input: AutomateReadyIssueInput,
  targetStatusName: string,
): Promise<SelectedProjectIssue> {
  const issues = await listProjectIssuesByStatusActivity(deps, {
    ...input,
    statusNames: [targetStatusName as ProjectStatusName],
  });
  const issue = issues[0];
  if (!issue) {
    throw new Error(`Could not find a ${targetStatusName} issue in GitHub Project ${input.projectOwner}/${input.projectNumber}.`);
  }
  const { currentStatusName: _currentStatusName, createdAt: _createdAt, ...selectedIssue } = issue;
  return selectedIssue;
}

function listProjectIssuesForStatuses(
  project: ProjectData,
  statusField: ResolvedStatusField,
  input: AutomateReadyIssueInput,
  targetStatusNames: readonly ProjectStatusName[],
): ListedProjectIssue[] {
  const targetStatuses = new Set(targetStatusNames);
  return project.items.nodes
    .filter(
      (item): item is ReadyProjectItem => {
        const statusName = item.fieldValueByName?.name;
        return typeof statusName === 'string'
          && targetStatuses.has(statusName as ProjectStatusName)
          && isProjectIssueContent(item.content)
          && matchesExpectedRepoBinding(item.content, input);
      },
    )
    .sort((left, right) => compareProjectIssueItems(left, right))
    .map((projectItem) => buildListedProjectIssue(project, statusField, input, projectItem));
}

function matchesExpectedRepoBinding(issue: ProjectIssueContent, input: AutomateReadyIssueInput): boolean {
  if (!input.expectedRepoOwner || !input.expectedRepoName) {
    return true;
  }
  return issue.repository.owner.login === input.expectedRepoOwner && issue.repository.name === input.expectedRepoName;
}

function compareProjectIssueItems(left: ReadyProjectItem, right: ReadyProjectItem): number {
  return left.content.createdAt.localeCompare(right.content.createdAt)
    || left.content.number - right.content.number;
}

function buildListedProjectIssue(
  project: ProjectData,
  statusField: ResolvedStatusField,
  input: AutomateReadyIssueInput,
  projectItem: ReadyProjectItem,
): ListedProjectIssue {
  const backlogStatusName = input.backlogStatusName ?? DEFAULT_BACKLOG_STATUS;
  const refinementStatusName = input.refinementStatusName ?? DEFAULT_REFINEMENT_STATUS;
  const refinedStatusName = input.refinedStatusName ?? DEFAULT_REFINED_STATUS;
  const readyStatusName = input.readyStatusName ?? DEFAULT_READY_STATUS;
  const inReviewStatusName = input.inReviewStatusName ?? DEFAULT_IN_REVIEW_STATUS;
  const escalatedStatusName = input.escalatedStatusName ?? DEFAULT_ESCALATED_STATUS;
  const blockedStatusName = input.blockedStatusName ?? DEFAULT_BLOCKED_STATUS;
  const issue = projectItem.content;
  const currentStatusName = projectItem.fieldValueByName?.name;
  if (!currentStatusName || !isProjectStatusName(currentStatusName)) {
    throw new Error(`Could not determine the project status for issue #${issue.number}.`);
  }

  return {
    projectId: project.id,
    projectItemId: projectItem.id,
    statusFieldId: statusField.id,
    backlogOptionId: getRequiredStatusOption(statusField, backlogStatusName).id,
    refinementOptionId: getRequiredStatusOption(statusField, refinementStatusName).id,
    refinedOptionId: getRequiredStatusOption(statusField, refinedStatusName).id,
    readyOptionId: getRequiredStatusOption(statusField, readyStatusName).id,
    inProgressOptionId: getRequiredStatusOption(statusField, DEFAULT_IN_PROGRESS_STATUS).id,
    inReviewOptionId: getRequiredStatusOption(statusField, inReviewStatusName).id,
    readyToMergeOptionId: getRequiredStatusOption(statusField, 'Ready to merge').id,
    escalatedOptionId: getRequiredStatusOption(statusField, escalatedStatusName).id,
    blockedOptionId: getRequiredStatusOption(statusField, blockedStatusName).id,
    issueNumber: issue.number,
    issueTitle: issue.title,
    taskDescription: buildTaskDescription(issue.title, issue.body),
    issueUrl: issue.url,
    ...(issue.labels?.nodes.length ? { labels: issue.labels.nodes.map((label) => label.name) } : {}),
    repoOwner: issue.repository.owner.login,
    repoName: issue.repository.name,
    defaultBranch: issue.repository.defaultBranchRef?.name ?? 'main',
    backlogStatusName,
    refinementStatusName,
    refinedStatusName,
    readyStatusName,
    inReviewStatusName,
    readyToMergeStatusName: 'Ready to merge',
    escalatedStatusName,
    currentStatusName,
    createdAt: issue.createdAt,
  };
}

function buildTaskDescription(issueTitle: string, issueBody: string): string {
  const description = issueBody.trim();
  return description.length > 0 ? description : issueTitle;
}

function isProjectSingleSelectField(field: ProjectFieldNode): field is ProjectSingleSelectField {
  return field.__typename === 'ProjectV2SingleSelectField';
}

function isProjectStatusName(value: string): value is ProjectStatusName {
  return CANONICAL_PROJECT_STATUS_NAMES.some((statusName) => statusName === value);
}

function isProjectIssueContent(content: ProjectItemNode['content'] | undefined): content is ProjectIssueContent {
  return content?.__typename === 'Issue';
}