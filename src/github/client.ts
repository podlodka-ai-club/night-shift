import type { OpenPROpts } from "./prs.js";
import type { Comment, Issue, PRRef, ProjectItem, StatusName } from "./types.js";

export interface GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly projectNodeId: string;
  readonly statusOptionIds: Readonly<Record<StatusName, string>>;

  // Projects v2
  getItem(itemId: string): Promise<ProjectItem>;
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
  openPullRequest(
    opts: Omit<OpenPROpts, "owner" | "repo">,
  ): Promise<PRRef>;
  setPullRequestReady(pullNumber: number, ready: boolean): Promise<void>;
}
