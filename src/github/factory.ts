import { readFile } from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { ConfigError } from "./errors.js";
import type { GitHubClient } from "./client.js";
import {
  addLabels,
  ensureLabel,
  getIssue,
  listComments,
  removeLabel,
  upsertComment,
} from "./issues.js";
import type { RestClient } from "./issues.js";
import {
  ensureStatusOptions,
  getItem as getProjectItem,
  resolveStatusField,
  setStatus as setProjectStatus,
  type GraphQLClient,
} from "./projects.js";
import { createBranch, openPullRequest, setPullRequestReady } from "./prs.js";
import {
  STATUS_NAMES,
  type GitHubConfig,
  GitHubConfigSchema,
  type StatusName,
} from "./types.js";

/**
 * Serializes calls through this client so a single GitHub App installation
 * never has more than one mutation in flight at a time. This is the simplest
 * mechanism that respects GitHub's secondary rate limits across bursty
 * writes without requiring a global scheduler.
 */
function singleFlight(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next as Promise<T>;
  };
}

async function resolvePrivateKey(config: GitHubConfig): Promise<string> {
  if (config.privateKey) return config.privateKey;
  if (config.privateKeyPath) {
    const resolved = path.isAbsolute(config.privateKeyPath)
      ? config.privateKeyPath
      : path.resolve(process.cwd(), config.privateKeyPath);
    try {
      return await readFile(resolved, "utf8");
    } catch (err) {
      throw new ConfigError(
        `failed to read privateKeyPath (${config.privateKeyPath})`,
        err,
      );
    }
  }
  // GitHubConfigSchema guarantees at least one of the two is set.
  throw new ConfigError("missing privateKey and privateKeyPath");
}

export async function createGitHubClient(
  input: unknown,
): Promise<GitHubClient> {
  const config = GitHubConfigSchema.parse(input);
  const privateKey = await resolvePrivateKey(config);

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
  });

  const rest: RestClient = octokit as unknown as RestClient;
  const gql: GraphQLClient = (async (query: string, variables) => {
    return (await octokit.graphql(query, variables as never)) as never;
  }) as GraphQLClient;

  const field = await resolveStatusField(
    gql,
    config.projectNodeId,
    config.statusFieldName,
  );
  const resolved = await ensureStatusOptions(gql, {
    fieldId: field.fieldId,
    existingOptions: field.options,
    manage: config.manageStatusOptions,
  });

  const run = singleFlight();
  const { owner, repo, projectNodeId } = config;
  const statusOptionIds = Object.freeze({ ...resolved.statusOptionIds }) as Readonly<
    Record<StatusName, string>
  >;

  const impl: GitHubClient = {
    owner,
    repo,
    projectNodeId,
    statusOptionIds,

    async getItem(itemId) {
      return getProjectItem(gql, { itemId, statusFieldName: config.statusFieldName });
    },
    async setStatus(itemId, status) {
      const optionId = statusOptionIds[status];
      if (!optionId) {
        throw new ConfigError(`missing option id for status "${status}"`);
      }
      await run(() =>
        setProjectStatus(gql, {
          projectNodeId,
          itemId,
          fieldId: resolved.fieldId,
          optionId,
        }),
      );
    },

    async getIssue(issueNumber) {
      return getIssue(rest, owner, repo, issueNumber);
    },
    async listComments(issueNumber) {
      return listComments(rest, owner, repo, issueNumber);
    },
    async addLabels(issueNumber, labels) {
      await run(() => addLabels(rest, owner, repo, issueNumber, labels));
    },
    async removeLabel(issueNumber, label) {
      await run(() => removeLabel(rest, owner, repo, issueNumber, label));
    },
    async upsertComment(issueNumber, markerId, body) {
      return run(() => upsertComment(rest, owner, repo, issueNumber, markerId, body));
    },

    async createBranch(branch, fromRef) {
      return run(() =>
        createBranch(rest, {
          owner,
          repo,
          branch,
          ...(fromRef !== undefined ? { fromRef } : {}),
        }),
      );
    },
    async openPullRequest(opts) {
      return run(() => openPullRequest(rest, { ...opts, owner, repo }));
    },
    async setPullRequestReady(pullNumber, ready) {
      await run(() =>
        setPullRequestReady(rest, gql, { owner, repo, pullNumber, ready }),
      );
    },
  };
  const client = Object.freeze(impl);

  // Statically ensure we wired every canonical status.
  for (const name of STATUS_NAMES) {
    if (!statusOptionIds[name]) {
      throw new ConfigError(`missing option id for status "${name}"`);
    }
  }

  // Reference ensureLabel to keep the export reachable from the client module.
  void ensureLabel;

  return client;
}
