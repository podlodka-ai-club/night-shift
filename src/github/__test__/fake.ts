import { ConfigError, GitHubNotFoundError } from "../errors.js";
import type { GitHubClient } from "../client.js";
import { markerLine } from "../issues.js";
import {
  STATUS_NAMES,
  type ChangedFile,
  type Issue,
  type ParsedWebhookEvent,
  type PRRef,
  type ProjectItem,
  type Review,
  type ReviewComment,
  type StatusName,
} from "../types.js";

export interface FakeEvent {
  kind: string;
  args: Record<string, unknown>;
}

interface StoredIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Set<string>;
  htmlUrl: string;
  comments: Array<{ id: number; body: string }>;
}

interface StoredItem {
  itemId: string;
  issueNumber?: number;
  status?: StatusName;
}

interface StoredPR {
  number: number;
  branch: string;
  baseBranch: string;
  headSha: string;
  url: string;
  draft: boolean;
  title: string;
  body?: string;
}

export interface FakeGitHubClient extends GitHubClient {
  readonly events: ReadonlyArray<FakeEvent>;
  emitFakeWebhook(event: ParsedWebhookEvent): ParsedWebhookEvent;
  seedIssue(issue: {
    number: number;
    title?: string;
    body?: string | null;
    state?: "open" | "closed";
    labels?: string[];
    htmlUrl?: string;
  }): void;
  seedItem(item: { itemId: string; issueNumber?: number; status?: StatusName }): void;
  seedDiff(pullNumber: number, diff: string): void;
  seedChangedFiles(pullNumber: number, files: ChangedFile[]): void;
  seedReviewComment(pullNumber: number, comment: ReviewComment): void;
  seedReview(pullNumber: number, review: Review): void;
  seedPr(pr: { number: number; branch: string; baseBranch?: string; headSha?: string; url?: string; draft?: boolean; title?: string }): void;
}

export function createInMemoryFakeGitHubClient(config?: {
  owner?: string;
  repo?: string;
  projectNodeId?: string;
}): FakeGitHubClient {
  const owner = config?.owner ?? "acme";
  const repo = config?.repo ?? "widgets";
  const projectNodeId = config?.projectNodeId ?? "PVT_FAKE";

  const statusOptionIds = Object.freeze(
    Object.fromEntries(STATUS_NAMES.map((s) => [s, `opt-${s}`])),
  ) as Readonly<Record<StatusName, string>>;

  const issues = new Map<number, StoredIssue>();
  const items = new Map<string, StoredItem>();
  const prs = new Map<number, StoredPR>();
  const branches = new Map<string, string>(); // ref → sha
  const events: FakeEvent[] = [];
  const diffs = new Map<number, string>();
  const changedFiles = new Map<number, ChangedFile[]>();
  const reviewComments = new Map<number, ReviewComment[]>();
  const reviews = new Map<number, Review[]>();
  let nextCommentId = 1;
  let nextPrNumber = 1;
  let nextReviewCommentId = 1000;
  let nextReviewId = 100;

  const log = (kind: string, args: Record<string, unknown>) =>
    events.push({ kind, args });

  const mustIssue = (n: number): StoredIssue => {
    const i = issues.get(n);
    if (!i) throw new GitHubNotFoundError(`issue #${n} not found`);
    return i;
  };

  const mustItem = (id: string): StoredItem => {
    const i = items.get(id);
    if (!i) throw new GitHubNotFoundError(`project item ${id} not found`);
    return i;
  };

  const client: FakeGitHubClient = {
    owner,
    repo,
    projectNodeId,
    statusOptionIds,
    get events() {
      return events;
    },

    seedIssue(issue) {
      issues.set(issue.number, {
        number: issue.number,
        title: issue.title ?? `Issue ${issue.number}`,
        body: issue.body ?? null,
        state: issue.state ?? "open",
        labels: new Set(issue.labels ?? []),
        htmlUrl: issue.htmlUrl ?? `https://github.com/${owner}/${repo}/issues/${issue.number}`,
        comments: [],
      });
    },
    seedItem(item) {
      items.set(item.itemId, {
        itemId: item.itemId,
        ...(item.issueNumber !== undefined ? { issueNumber: item.issueNumber } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}),
      });
    },
    seedDiff(pullNumber, diff) {
      diffs.set(pullNumber, diff);
    },
    seedChangedFiles(pullNumber, files) {
      changedFiles.set(pullNumber, files);
    },
    seedReviewComment(pullNumber, comment) {
      const arr = reviewComments.get(pullNumber) ?? [];
      arr.push(comment);
      reviewComments.set(pullNumber, arr);
    },
    seedReview(pullNumber, review) {
      const arr = reviews.get(pullNumber) ?? [];
      arr.push(review);
      reviews.set(pullNumber, arr);
    },
    seedPr(pr) {
      const stored: StoredPR = {
        number: pr.number,
        branch: pr.branch,
        baseBranch: pr.baseBranch ?? "main",
        headSha: pr.headSha ?? "0000000000000000000000000000000000000000",
        url: pr.url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`,
        draft: pr.draft ?? false,
        title: pr.title ?? `PR #${pr.number}`,
      };
      prs.set(pr.number, stored);
    },

    async getItem(itemId: string): Promise<ProjectItem> {
      log("getItem", { itemId });
      const it = mustItem(itemId);
      const base: ProjectItem = {
        itemId: it.itemId,
        projectNodeId,
        ...(it.issueNumber !== undefined ? { issueNumber: it.issueNumber } : {}),
        ...(it.status !== undefined ? { status: it.status } : {}),
      };
      return base;
    },
    async setStatus(itemId: string, status: StatusName): Promise<void> {
      if (!statusOptionIds[status]) {
        throw new ConfigError(`missing option id for status "${status}"`);
      }
      log("setStatus", { itemId, status });
      const it = mustItem(itemId);
      it.status = status;
    },

    async getIssue(issueNumber: number): Promise<Issue> {
      log("getIssue", { issueNumber });
      const i = mustIssue(issueNumber);
      return {
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        labels: [...i.labels],
        htmlUrl: i.htmlUrl,
      };
    },
    async addLabels(issueNumber: number, labels: string[]): Promise<void> {
      log("addLabels", { issueNumber, labels });
      const i = mustIssue(issueNumber);
      for (const l of labels) i.labels.add(l);
    },
    async removeLabel(issueNumber: number, label: string): Promise<void> {
      log("removeLabel", { issueNumber, label });
      const i = issues.get(issueNumber);
      if (!i) return; // tolerate
      i.labels.delete(label);
    },
    async upsertComment(issueNumber, markerId, body) {
      log("upsertComment", { issueNumber, markerId });
      const i = mustIssue(issueNumber);
      const marker = markerLine(markerId);
      const bodyWithMarker = body.startsWith(marker) ? body : `${marker}\n${body}`;
      const existing = i.comments.find((c) => c.body.startsWith(marker));
      if (existing) {
        existing.body = bodyWithMarker;
        return { commentId: existing.id };
      }
      const id = nextCommentId++;
      i.comments.push({ id, body: bodyWithMarker });
      return { commentId: id };
    },
    async listComments(issueNumber) {
      log("listComments", { issueNumber });
      const i = mustIssue(issueNumber);
      return i.comments.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: "1970-01-01T00:00:00Z",
        updatedAt: "1970-01-01T00:00:00Z",
      }));
    },

    async createBranch(branch, fromRef) {
      log("createBranch", { branch, ...(fromRef !== undefined ? { fromRef } : {}) });
      const ref = `refs/heads/${branch}`;
      const sha = fromRef ? branches.get(`refs/${fromRef}`) ?? "0000000000000000000000000000000000000000" : "0000000000000000000000000000000000000000";
      const existing = branches.get(ref);
      if (existing) {
        if (existing !== sha) {
          throw new GitHubNotFoundError(
            `branch ${branch} exists at ${existing}, wanted ${sha}`,
          );
        }
        return { ref, sha: existing };
      }
      branches.set(ref, sha);
      return { ref, sha };
    },
    async openPullRequest(opts): Promise<PRRef> {
      log("openPullRequest", { ...opts });
      const number = nextPrNumber++;
      const stored: StoredPR = {
        number,
        branch: opts.head,
        baseBranch: opts.base,
        headSha: branches.get(`refs/heads/${opts.head}`) ?? "0000000000000000000000000000000000000000",
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        draft: opts.draft ?? false,
        title: opts.title,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      };
      prs.set(number, stored);
      return {
        number,
        url: stored.url,
        branch: stored.branch,
        baseBranch: stored.baseBranch,
        headSha: stored.headSha,
      };
    },
    async pushBranch(branch, sha) {
      log("pushBranch", { branch, sha });
      const ref = `refs/heads/${branch}`;
      branches.set(ref, sha);
      // Mirror onto any open PR with this head branch so `headSha` stays fresh.
      for (const pr of prs.values()) {
        if (pr.branch === branch) pr.headSha = sha;
      }
      return { ref, sha };
    },
    async upsertPullRequest(opts): Promise<PRRef> {
      log("upsertPullRequest", { ...opts });
      for (const pr of prs.values()) {
        if (pr.branch === opts.head) {
          pr.title = opts.title;
          if (opts.body !== undefined) pr.body = opts.body;
          pr.baseBranch = opts.base;
          return {
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            baseBranch: pr.baseBranch,
            headSha: pr.headSha,
          };
        }
      }
      const number = nextPrNumber++;
      const stored: StoredPR = {
        number,
        branch: opts.head,
        baseBranch: opts.base,
        headSha: branches.get(`refs/heads/${opts.head}`) ?? "0000000000000000000000000000000000000000",
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        draft: opts.draft ?? false,
        title: opts.title,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      };
      prs.set(number, stored);
      return {
        number,
        url: stored.url,
        branch: stored.branch,
        baseBranch: stored.baseBranch,
        headSha: stored.headSha,
      };
    },
    async setPullRequestReady(pullNumber, ready) {
      log("setPullRequestReady", { pullNumber, ready });
      const pr = prs.get(pullNumber);
      if (!pr) throw new GitHubNotFoundError(`pr #${pullNumber} not found`);
      pr.draft = !ready;
    },

    async getPullRequestDiff(pullNumber) {
      log("getPullRequestDiff", { pullNumber });
      const diff = diffs.get(pullNumber);
      return diff ?? "";
    },
    async listChangedFiles(pullNumber) {
      log("listChangedFiles", { pullNumber });
      return changedFiles.get(pullNumber) ?? [];
    },
    async listReviewComments(pullNumber) {
      log("listReviewComments", { pullNumber });
      return reviewComments.get(pullNumber) ?? [];
    },
    async upsertReviewComment(pullNumber, markerId, opts) {
      log("upsertReviewComment", { pullNumber, markerId, path: opts.path, line: opts.line });
      const marker = markerLine(markerId);
      const bodyWithMarker = opts.body.startsWith(marker)
        ? opts.body
        : `${marker}\n${opts.body}`;
      const arr = reviewComments.get(pullNumber) ?? [];
      const existing = arr.find(
        (c) =>
          c.body.startsWith(marker) &&
          c.path === opts.path &&
          c.line === opts.line,
      );
      if (existing) {
        existing.body = bodyWithMarker;
        return { commentId: existing.id };
      }
      const id = nextReviewCommentId++;
      arr.push({ id, body: bodyWithMarker, path: opts.path, line: opts.line });
      reviewComments.set(pullNumber, arr);
      return { commentId: id };
    },
    async createReview(pullNumber, opts) {
      const validEvents = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
      if (!validEvents.has(opts.event)) {
        throw new Error(`unsupported review event: ${opts.event}`);
      }
      log("createReview", { pullNumber, event: opts.event });
      const id = nextReviewId++;
      const review: Review = {
        id,
        body: opts.body,
        state: opts.event === "APPROVE" ? "APPROVED" :
          opts.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
        authorAssociation: "NONE",
      };
      const arr = reviews.get(pullNumber) ?? [];
      arr.push(review);
      reviews.set(pullNumber, arr);
      return { id };
    },
    async listReviews(pullNumber) {
      log("listReviews", { pullNumber });
      return reviews.get(pullNumber) ?? [];
    },
    async updateReview(pullNumber, reviewId, opts) {
      log("updateReview", { pullNumber, reviewId });
      const arr = reviews.get(pullNumber) ?? [];
      const review = arr.find((r) => r.id === reviewId);
      if (!review) throw new GitHubNotFoundError(`review #${reviewId} not found`);
      review.body = opts.body;
    },

    emitFakeWebhook(event) {
      log("emitFakeWebhook", { kind: event.kind });
      return event;
    },
  };

  return client;
}
