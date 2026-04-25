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
  listItemsByStatus as listProjectItemsByStatus,
  resolveProjectNodeId,
  resolveStatusField,
  setStatus as setProjectStatus,
  type GraphQLClient,
} from "./projects.js";
import {
  createBranch,
  createReview,
  getPullRequestDiff,
  listChangedFiles,
  listReviewComments,
  listReviews,
  openPullRequest,
  pushBranch,
  setPullRequestReady,
  updateReview,
  upsertPullRequest,
  upsertReviewComment,
} from "./prs.js";
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

function createOctokit(config: GitHubConfig): Octokit {
  if (config.token) {
    return new Octokit({ auth: config.token });
  }
  // App auth — resolvePrivateKey must be called before this for async key loading.
  // This sync path is only used after privateKey is already resolved.
  throw new ConfigError("createOctokit called without token or resolved App auth");
}

export async function createGitHubClient(
  input: unknown,
): Promise<GitHubClient> {
  const config = GitHubConfigSchema.parse(input);

  let octokit: Octokit;
  if (config.token) {
    octokit = new Octokit({ auth: config.token });
  } else {
    const privateKey = await resolvePrivateKey(config);
    octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey,
        installationId: config.installationId,
      },
    });
  }

  const rest: RestClient = octokit as unknown as RestClient;
  const gql: GraphQLClient = (async (query: string, variables) => {
    return (await octokit.graphql(query, variables as never)) as never;
  }) as GraphQLClient;

  // Resolve projectNodeId from project number if not provided directly
  let projectNodeId = config.projectNodeId;
  if (!projectNodeId) {
    projectNodeId = await resolveProjectNodeId(gql, {
      projectOwner: config.projectOwner!,
      projectOwnerType: config.projectOwnerType!,
      projectNumber: config.projectNumber!,
    });
  }

  const field = await resolveStatusField(
    gql,
    projectNodeId,
    config.statusFieldName,
  );
  const resolved = await ensureStatusOptions(gql, {
    fieldId: field.fieldId,
    existingOptions: field.options,
    manage: config.manageStatusOptions,
  });

  const run = singleFlight();
  const { owner, repo } = config;
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
    async listItemsByStatus(status) {
      return listProjectItemsByStatus(gql, {
        projectNodeId,
        statusFieldName: config.statusFieldName,
        status,
      });
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
    async pushBranch(branch, sha) {
      return run(() => pushBranch(rest, { owner, repo, branch, sha }));
    },
    async openPullRequest(opts) {
      return run(() => openPullRequest(rest, { ...opts, owner, repo }));
    },
    async upsertPullRequest(opts) {
      return run(() => upsertPullRequest(rest, { ...opts, owner, repo }));
    },
    async setPullRequestReady(pullNumber, ready) {
      await run(() =>
        setPullRequestReady(rest, gql, { owner, repo, pullNumber, ready }),
      );
    },

    async getPullRequestDiff(pullNumber) {
      return getPullRequestDiff(rest, owner, repo, pullNumber);
    },
    async listChangedFiles(pullNumber) {
      return listChangedFiles(rest, owner, repo, pullNumber);
    },
    async listReviewComments(pullNumber) {
      return listReviewComments(rest, owner, repo, pullNumber);
    },
    async upsertReviewComment(pullNumber, markerId, opts) {
      return run(() =>
        upsertReviewComment(rest, owner, repo, pullNumber, markerId, opts),
      );
    },
    async createReview(pullNumber, opts) {
      return run(() =>
        createReview(rest, owner, repo, pullNumber, opts),
      );
    },
    async listReviews(pullNumber) {
      return listReviews(rest, owner, repo, pullNumber);
    },
    async updateReview(pullNumber, reviewId, opts) {
      await run(() =>
        updateReview(rest, owner, repo, pullNumber, reviewId, opts),
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
