import { ConfigError } from "./errors.js";
import { retryable } from "./retry.js";
import {
  type ProjectItem,
  type StatusName,
  StatusNameSchema,
  STATUS_NAMES,
} from "./types.js";

/** Minimal GraphQL client surface we depend on. Satisfied by `@octokit/graphql`. */
export interface GraphQLClient {
  <T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface StatusFieldDescriptor {
  fieldId: string;
  /** optionId → name as returned by GitHub (not yet validated against StatusName). */
  options: Record<string, string>;
}

export interface ResolvedStatusField extends StatusFieldDescriptor {
  /** StatusName → optionId; only the 7 canonical statuses are guaranteed here. */
  statusOptionIds: Readonly<Record<StatusName, string>>;
}

const STATUS_COLORS: Record<StatusName, string> = {
  Backlog: "GRAY",
  Refinement: "BLUE",
  Refined: "BLUE",
  Ready: "GREEN",
  "In progress": "YELLOW",
  "In review": "PURPLE",
  "Ready to merge": "GREEN",
};

const FIELDS_QUERY = /* GraphQL */ `
  query FieldsForProject($projectNodeId: ID!) {
    node(id: $projectNodeId) {
      ... on ProjectV2 {
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
            ... on ProjectV2FieldCommon {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const UPDATE_OPTIONS_MUTATION = /* GraphQL */ `
  mutation UpdateStatusField($input: UpdateProjectV2FieldInput!) {
    updateProjectV2Field(input: $input) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
          }
        }
      }
    }
  }
`;

const SET_STATUS_MUTATION = /* GraphQL */ `
  mutation SetStatus($input: UpdateProjectV2ItemFieldValueInput!) {
    updateProjectV2ItemFieldValue(input: $input) {
      projectV2Item {
        id
      }
    }
  }
`;

const ITEM_QUERY = /* GraphQL */ `
  query GetItem($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        id
        project { id }
        content {
          __typename
          ... on Issue { number }
          ... on PullRequest { number }
        }
        fieldValues(first: 20) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field {
                ... on ProjectV2FieldCommon { id name }
              }
            }
          }
        }
      }
    }
  }
`;

interface FieldNode {
  __typename: string;
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

export async function resolveStatusField(
  gql: GraphQLClient,
  projectNodeId: string,
  fieldName: string,
): Promise<StatusFieldDescriptor> {
  const data = await retryable(() =>
    gql<{ node?: { fields?: { nodes: FieldNode[] } } }>(FIELDS_QUERY, { projectNodeId }),
  );
  const nodes = data.node?.fields?.nodes ?? [];
  const field = nodes.find(
    (n) => n.__typename === "ProjectV2SingleSelectField" && n.name === fieldName,
  );
  if (!field) {
    throw new ConfigError(
      `project ${projectNodeId} has no single-select field named "${fieldName}"`,
    );
  }
  const options: Record<string, string> = {};
  for (const o of field.options ?? []) options[o.id] = o.name;
  return { fieldId: field.id, options };
}

export function buildStatusOptionIds(
  options: Record<string, string>,
): Partial<Record<StatusName, string>> {
  const out: Partial<Record<StatusName, string>> = {};
  for (const [id, name] of Object.entries(options)) {
    const parsed = StatusNameSchema.safeParse(name);
    if (parsed.success) out[parsed.data] = id;
  }
  return out;
}

export async function ensureStatusOptions(
  gql: GraphQLClient,
  args: {
    fieldId: string;
    existingOptions: Record<string, string>;
    manage: boolean;
  },
): Promise<ResolvedStatusField> {
  const existingByName = new Set(Object.values(args.existingOptions));
  const missing = STATUS_NAMES.filter((s) => !existingByName.has(s));

  if (missing.length === 0) {
    const statusOptionIds = buildStatusOptionIds(args.existingOptions);
    return freeze({
      fieldId: args.fieldId,
      options: args.existingOptions,
      statusOptionIds: statusOptionIds as Record<StatusName, string>,
    });
  }

  if (!args.manage) {
    throw new ConfigError(
      `project status field is missing required options: ${missing.join(", ")}`,
    );
  }

  const nextOptions = [
    ...Object.entries(args.existingOptions).map(([, name]) => ({
      name,
      color: STATUS_COLORS[name as StatusName] ?? "GRAY",
      description: "",
    })),
    ...missing.map((name) => ({
      name,
      color: STATUS_COLORS[name],
      description: `night-shift auto-created status: ${name}`,
    })),
  ];

  const updated = await retryable(() =>
    gql<{
      updateProjectV2Field: {
        projectV2Field: { id: string; options: Array<{ id: string; name: string }> };
      };
    }>(UPDATE_OPTIONS_MUTATION, {
      input: {
        fieldId: args.fieldId,
        singleSelectOptions: nextOptions,
      },
    }),
  );

  const newOptions: Record<string, string> = {};
  for (const o of updated.updateProjectV2Field.projectV2Field.options) {
    newOptions[o.id] = o.name;
  }
  const statusOptionIds = buildStatusOptionIds(newOptions) as Record<StatusName, string>;
  const stillMissing = STATUS_NAMES.filter((s) => !statusOptionIds[s]);
  if (stillMissing.length > 0) {
    throw new ConfigError(
      `failed to create status options: ${stillMissing.join(", ")}`,
    );
  }
  return freeze({ fieldId: args.fieldId, options: newOptions, statusOptionIds });
}

export async function setStatus(
  gql: GraphQLClient,
  args: {
    projectNodeId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  },
): Promise<void> {
  await retryable(() =>
    gql(SET_STATUS_MUTATION, {
      input: {
        projectId: args.projectNodeId,
        itemId: args.itemId,
        fieldId: args.fieldId,
        value: { singleSelectOptionId: args.optionId },
      },
    }),
  );
}

export async function getItem(
  gql: GraphQLClient,
  args: { itemId: string; statusFieldName: string },
): Promise<ProjectItem> {
  interface ItemNode {
    id: string;
    project: { id: string };
    content?: { __typename: string; number?: number };
    fieldValues: {
      nodes: Array<{
        __typename: string;
        name?: string;
        field?: { id: string; name: string };
      }>;
    };
  }
  const data = await retryable(() =>
    gql<{ node: ItemNode | null }>(ITEM_QUERY, { itemId: args.itemId }),
  );
  if (!data.node) {
    throw new ConfigError(`project item ${args.itemId} not found`);
  }
  const statusNode = data.node.fieldValues.nodes.find(
    (n) =>
      n.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      n.field?.name === args.statusFieldName,
  );
  const statusName = statusNode?.name
    ? StatusNameSchema.safeParse(statusNode.name)
    : undefined;
  const item: ProjectItem = {
    itemId: data.node.id,
    projectNodeId: data.node.project.id,
    ...(data.node.content?.number ? { issueNumber: data.node.content.number } : {}),
    ...(statusName && statusName.success ? { status: statusName.data } : {}),
  };
  return item;
}

function freeze<T extends object>(v: T): Readonly<T> {
  return Object.freeze(v);
}
