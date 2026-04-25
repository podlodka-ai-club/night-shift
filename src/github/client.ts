import type { OpenPROpts, UpsertPROpts } from "./prs.js";
import type { ChangedFile, Comment, Issue, PRRef, ProjectItem, ProjectItemSummary, ReviewComment, Review, StatusName } from "./types.js";

export interface GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly projectNodeId: string;
  readonly statusOptionIds: Readonly<Record<StatusName, string>>;

  // Projects v2
  getItem(itemId: string): Promise<ProjectItem>;
  listItemsByStatus(status: StatusName): Promise<ProjectItemSummary[]>;
  setStatus(itemId: string, status: StatusName): Promise<void>;

  // Issues & comments
  getIssue(issueNumber: number): Promise<Issue>;
  listComments(issueNumber: number): Promise<Comment[]>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  upsertComment(
    issueNumber: number,
    markerId: string,
    body: string,
  ): Promise<{ commentId: number }>;

  // PRs & branches
  createBranch(branch: string, fromRef?: string): Promise<{ ref: string; sha: string }>;
  pushBranch(branch: string, sha: string): Promise<{ ref: string; sha: string }>;
  openPullRequest(
    opts: Omit<OpenPROpts, "owner" | "repo">,
  ): Promise<PRRef>;
  upsertPullRequest(
    opts: Omit<UpsertPROpts, "owner" | "repo">,
  ): Promise<PRRef>;
  setPullRequestReady(pullNumber: number, ready: boolean): Promise<void>;

  // PR reviews
  getPullRequestDiff(pullNumber: number): Promise<string>;
  listChangedFiles(pullNumber: number): Promise<ChangedFile[]>;
  listReviewComments(pullNumber: number): Promise<ReviewComment[]>;
  upsertReviewComment(
    pullNumber: number,
    markerId: string,
    opts: { path: string; line: number; body: string },
  ): Promise<{ commentId: number }>;
  createReview(
    pullNumber: number,
    opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<{ id: number }>;
  listReviews(pullNumber: number): Promise<Review[]>;
  updateReview(
    pullNumber: number,
    reviewId: number,
    opts: { body: string },
  ): Promise<void>;
}
