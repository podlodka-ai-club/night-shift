import {
  DEFAULT_BLOCKED_STATUS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_STATUS,
  type AutomateReadyIssueInput,
  type MoveProjectItemStatusInput,
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
  | { __typename: 'ProjectV2SingleSelectField'; id: string; name: string; options: Array<{ id: string; name: string }> }
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
        repository: { name: string; owner: { login: string }; defaultBranchRef: null | { name: string } };
      }
    | { __typename: string };
}

type ProjectSingleSelectField = Extract<ProjectFieldNode, { __typename: 'ProjectV2SingleSelectField' }>;
type ProjectIssueContent = Extract<NonNullable<ProjectItemNode['content']>, { __typename: 'Issue' }>;
type ProjectStatusOption = ProjectSingleSelectField['options'][number];
type ReadyProjectItem = ProjectItemNode & { content: ProjectIssueContent };

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

export async function getTopReadyIssueActivity(
  deps: GitHubActivityDeps,
  input: AutomateReadyIssueInput,
): Promise<SelectedProjectIssue> {
  const readyStatusName = input.readyStatusName ?? DEFAULT_READY_STATUS;
  const inProgressStatusName = DEFAULT_IN_PROGRESS_STATUS;
  const inReviewStatusName = input.inReviewStatusName ?? DEFAULT_IN_REVIEW_STATUS;
  const blockedStatusName = input.blockedStatusName ?? DEFAULT_BLOCKED_STATUS;
  const project = await lookupProject(deps, input.projectOwner, input.projectNumber);
  const statusField = getProjectStatusField(project);
  const readyOption = getRequiredStatusOption(statusField, readyStatusName);
  const inProgressOption = getRequiredStatusOption(statusField, inProgressStatusName);
  const inReviewOption = getRequiredStatusOption(statusField, inReviewStatusName);
  const blockedOption = findStatusOption(statusField, blockedStatusName);
  const readyItem = getReadyIssueItem(project, readyStatusName, input.projectOwner, input.projectNumber);
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

function getProjectStatusField(project: ProjectData): ProjectSingleSelectField {
  const statusField = project.fields.nodes.find(
    (field): field is ProjectSingleSelectField => isProjectSingleSelectField(field) && field.name === PROJECT_STATUS_FIELD_NAME,
  );
  if (!statusField) {
    throw new Error('The GitHub Project does not contain a Status field.');
  }
  return statusField;
}

function getRequiredStatusOption(statusField: ProjectSingleSelectField, statusName: string): ProjectStatusOption {
  const statusOption = findStatusOption(statusField, statusName);
  if (!statusOption) {
    throw new Error(`Could not find the ${statusName} status option on the GitHub Project.`);
  }
  return statusOption;
}

function findStatusOption(statusField: ProjectSingleSelectField, statusName: string): ProjectStatusOption | undefined {
  return statusField.options.find((option) => option.name === statusName);
}

function getReadyIssueItem(
  project: ProjectData,
  readyStatusName: string,
  projectOwner: string,
  projectNumber: number,
): ReadyProjectItem {
  const readyItem = project.items.nodes.find(
    (item): item is ReadyProjectItem => item.fieldValueByName?.name === readyStatusName && isProjectIssueContent(item.content),
  );
  if (!readyItem) {
    throw new Error(`Could not find a Ready issue in GitHub Project ${projectOwner}/${projectNumber}.`);
  }
  return readyItem;
}

function buildTaskDescription(issueTitle: string, issueBody: string): string {
  const description = issueBody.trim();
  return description.length > 0 ? description : issueTitle;
}

function isProjectSingleSelectField(field: ProjectFieldNode): field is ProjectSingleSelectField {
  return field.__typename === 'ProjectV2SingleSelectField';
}

function isProjectIssueContent(content: ProjectItemNode['content'] | undefined): content is ProjectIssueContent {
  return content?.__typename === 'Issue';
}