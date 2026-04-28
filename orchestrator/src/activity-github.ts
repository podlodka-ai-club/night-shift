import type {
  AddIssueLabelsInput,
  AutomateReadyIssueInput,
  CreatePullRequestReviewInput,
  CreatedPullRequest,
  GetPullRequestDetailsInput,
  EnsureProjectStatusOptionsInput,
  IssueComment,
  IssueCommentInput,
  ListedProjectIssue,
  ListIssueCommentsInput,
  ListProjectIssuesByStatusInput,
  MoveProjectItemStatusInput,
  OpenPullRequestInput,
  PullRequestChangedFile,
  PullRequestDetails,
  PullRequestReviewComment,
  PullRequestReviewContextInput,
  ResolvedProjectStatusOptions,
  SetPullRequestReadyInput,
  SelectedProjectIssue,
  UpsertPullRequestReviewCommentInput,
  UpsertIssueCommentInput,
} from './shared';
import type { GitHubActivityDeps } from './activity-deps';
import {
  addIssueLabelsActivity,
  commentOnIssueActivity,
  createPullRequestReviewActivity,
  getPullRequestDetailsActivity,
  getPullRequestDiffActivity,
  listPullRequestFilesActivity,
  listPullRequestReviewCommentsActivity,
  listIssueCommentsActivity,
  openPullRequestActivity,
  setPullRequestReadyActivity,
  upsertPullRequestReviewCommentActivity,
  upsertIssueCommentActivity,
} from './activity-github-pull-request';
import {
  ensureProjectStatusOptionsActivity,
  getTopBacklogIssueActivity,
  getTopReadyIssueActivity,
  listProjectIssuesByStatusActivity,
  moveProjectItemStatusActivity,
} from './activity-github-project';

export { buildIssueComment, buildMarkerComment } from './activity-github-pull-request';
export { buildNightShiftMarker, isNightShiftMarkerComment } from './comment-markers';

export function createGitHubActivities(deps: GitHubActivityDeps) {
  return {
    async ensureProjectStatusOptions(input: EnsureProjectStatusOptionsInput): Promise<ResolvedProjectStatusOptions> {
      return ensureProjectStatusOptionsActivity(deps, input);
    },

    async getTopReadyIssue(input: AutomateReadyIssueInput): Promise<SelectedProjectIssue> {
      return getTopReadyIssueActivity(deps, input);
    },

    async getTopBacklogIssue(input: AutomateReadyIssueInput): Promise<SelectedProjectIssue> {
      return getTopBacklogIssueActivity(deps, input);
    },

    async listProjectIssuesByStatus(input: ListProjectIssuesByStatusInput): Promise<ListedProjectIssue[]> {
      return listProjectIssuesByStatusActivity(deps, input);
    },

    async openPullRequest(input: OpenPullRequestInput): Promise<CreatedPullRequest> {
      return openPullRequestActivity(deps, input);
    },

    async addIssueLabels(input: AddIssueLabelsInput): Promise<void> {
      return addIssueLabelsActivity(deps, input);
    },

    async listIssueComments(input: ListIssueCommentsInput): Promise<IssueComment[]> {
      return listIssueCommentsActivity(deps, input);
    },

    async getPullRequestDetails(input: GetPullRequestDetailsInput): Promise<PullRequestDetails> {
      return getPullRequestDetailsActivity(deps, input);
    },

    async getPullRequestDiff(input: PullRequestReviewContextInput): Promise<string> {
      return getPullRequestDiffActivity(deps, input);
    },

    async listPullRequestFiles(input: PullRequestReviewContextInput): Promise<PullRequestChangedFile[]> {
      return listPullRequestFilesActivity(deps, input);
    },

    async listPullRequestReviewComments(input: PullRequestReviewContextInput): Promise<PullRequestReviewComment[]> {
      return listPullRequestReviewCommentsActivity(deps, input);
    },

    async setPullRequestReady(input: SetPullRequestReadyInput): Promise<void> {
      return setPullRequestReadyActivity(deps, input);
    },

    async createPullRequestReview(input: CreatePullRequestReviewInput): Promise<void> {
      return createPullRequestReviewActivity(deps, input);
    },

    async upsertPullRequestReviewComment(input: UpsertPullRequestReviewCommentInput): Promise<void> {
      return upsertPullRequestReviewCommentActivity(deps, input);
    },

    async commentOnIssue(input: IssueCommentInput): Promise<void> {
      return commentOnIssueActivity(deps, input);
    },

    async upsertIssueComment(input: UpsertIssueCommentInput): Promise<void> {
      return upsertIssueCommentActivity(deps, input);
    },

    async moveProjectItemStatus(input: MoveProjectItemStatusInput): Promise<void> {
      return moveProjectItemStatusActivity(deps, input);
    },
  };
}