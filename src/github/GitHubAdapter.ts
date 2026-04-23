import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { Config } from '../config.js';
import { ProjectItem } from '../types.js';

interface ProjectFieldOption {
  id: string;
  name: string;
}

interface ProjectMeta {
  projectId: string;
  statusFieldId: string;
  options: Record<string, ProjectFieldOption>; // keyed by option name (lowercased)
}

/** Thin wrapper around GitHub Projects v2 GraphQL and REST APIs. */
export class GitHubAdapter {
  private readonly gql: ReturnType<typeof graphql.defaults>;
  private readonly rest: Octokit;
  private meta: ProjectMeta | null = null;

  constructor(private readonly config: Config) {
    this.gql = graphql.defaults({ headers: { authorization: `token ${config.github.token}` } });
    this.rest = new Octokit({ auth: config.github.token });
  }

  /** Must be called once before any other operation to populate project/field metadata. */
  async initialize(): Promise<void> {
    const { projectOwner, projectOwnerType, projectNumber, statusFieldName } = this.config.github;

    const query =
      projectOwnerType === 'org'
        ? /* GraphQL */ `
          query($owner: String!, $number: Int!) {
            organization(login: $owner) {
              projectV2(number: $number) { id fields(first: 30) { nodes { ...FieldParts } } }
            }
          }`
        : /* GraphQL */ `
          query($owner: String!, $number: Int!) {
            user(login: $owner) {
              projectV2(number: $number) { id fields(first: 30) { nodes { ...FieldParts } } }
            }
          }`;

    const fragment = /* GraphQL */ `
      fragment FieldParts on ProjectV2FieldConfiguration {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }`;

    const data = await this.gql<Record<string, unknown>>(query + fragment, {
      owner: projectOwner,
      number: projectNumber,
    });

    const root =
      projectOwnerType === 'org'
        ? (data as { organization: { projectV2: unknown } }).organization.projectV2
        : (data as { user: { projectV2: unknown } }).user.projectV2;

    const project = root as {
      id: string;
      fields: { nodes: Array<{ id?: string; name?: string; options?: ProjectFieldOption[] }> };
    };

    const statusField = project.fields.nodes.find(
      (f) => f.name?.toLowerCase() === statusFieldName.toLowerCase() && f.options,
    );
    if (!statusField?.id || !statusField.options) {
      throw new Error(`Status field "${statusFieldName}" not found in project`);
    }

    const options: Record<string, ProjectFieldOption> = {};
    for (const opt of statusField.options) {
      options[opt.name.toLowerCase()] = opt;
    }

    this.meta = { projectId: project.id, statusFieldId: statusField.id, options };
  }

  private getMeta(): ProjectMeta {
    if (!this.meta) throw new Error('GitHubAdapter.initialize() must be called first');
    return this.meta;
  }

  private optionId(statusValue: string): string {
    const opt = this.getMeta().options[statusValue.toLowerCase()];
    if (!opt) throw new Error(`Unknown status option: "${statusValue}"`);
    return opt.id;
  }

  /** Returns Project items whose Status field matches the configured "Ready" value. */
  async listReadyItems(): Promise<ProjectItem[]> {
    const { projectId } = this.getMeta();
    const { statusFieldName, statusValues } = this.config.github;

    const data = await this.gql<{
      node: {
        items: {
          nodes: Array<{
            id: string;
            fieldValues: {
              nodes: Array<{
                name?: string;
                field?: { name?: string };
              }>;
            };
            content?: {
              number?: number;
              title?: string;
              body?: string;
              url?: string;
            };
          }>;
        };
      };
    }>(
      /* GraphQL */ `
        query($id: ID!) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 50) {
                nodes {
                  id
                  fieldValues(first: 10) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2SingleSelectField { name } }
                      }
                    }
                  }
                  content {
                    ... on Issue { number title body url }
                  }
                }
              }
            }
          }
        }`,
      { id: projectId },
    );

    return data.node.items.nodes
      .filter((item) => {
        const statusVal = item.fieldValues.nodes.find(
          (fv) => fv.field?.name?.toLowerCase() === statusFieldName.toLowerCase(),
        );
        return statusVal?.name === statusValues.ready;
      })
      .map((item) => ({
        id: item.id,
        issueNumber: item.content?.number,
        issueTitle: item.content?.title,
        issueBody: item.content?.body,
        issueUrl: item.content?.url,
      }));
  }

  /** Updates the Status field of a project item. */
  async updateItemStatus(itemId: string, statusValue: string): Promise<void> {
    const { projectId, statusFieldId } = this.getMeta();
    const optId = this.optionId(statusValue);

    await this.gql(
      /* GraphQL */ `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`,
      { projectId, itemId, fieldId: statusFieldId, optionId: optId },
    );
  }

  /** Posts a comment on a GitHub issue. */
  async postIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.rest.issues.createComment({
      owner: this.config.github.repoOwner,
      repo: this.config.github.repoName,
      issue_number: issueNumber,
      body,
    });
  }

  /** Creates a pull request and returns its number and URL. */
  async createPR(params: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; url: string }> {
    const { data } = await this.rest.pulls.create({
      owner: this.config.github.repoOwner,
      repo: this.config.github.repoName,
      ...params,
    });
    return { number: data.number, url: data.html_url };
  }

  /** Returns an existing open PR for the given head branch, if one exists. */
  async findOpenPRByHead(head: string): Promise<{ number: number; url: string } | null> {
    const { data } = await this.rest.pulls.list({
      owner: this.config.github.repoOwner,
      repo: this.config.github.repoName,
      state: 'open',
      head: `${this.config.github.repoOwner}:${head}`,
    });

    const pr = data[0];
    return pr ? { number: pr.number, url: pr.html_url } : null;
  }

  /** Replaces the PR body. */
  async updatePRBody(prNumber: number, body: string): Promise<void> {
    await this.rest.pulls.update({
      owner: this.config.github.repoOwner,
      repo: this.config.github.repoName,
      pull_number: prNumber,
      body,
    });
  }

  /** Adds a comment to a pull request. */
  async addPRComment(prNumber: number, body: string): Promise<void> {
    await this.rest.issues.createComment({
      owner: this.config.github.repoOwner,
      repo: this.config.github.repoName,
      issue_number: prNumber,
      body,
    });
  }
}
