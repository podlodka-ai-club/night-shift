import type {
  AutomateReadyIssueInput,
  CreatedPullRequest,
  EnsureProjectStatusOptionsInput,
  IssueComment,
  IssueCommentInput,
  ListIssueCommentsInput,
  MoveProjectItemStatusInput,
  OpenPullRequestInput,
  ResolvedProjectStatusOptions,
  SelectedProjectIssue,
  UpsertIssueCommentInput,
} from './shared';
import type { GitHubActivityDeps } from './activity-deps';
import {
  commentOnIssueActivity,
  listIssueCommentsActivity,
  openPullRequestActivity,
  upsertIssueCommentActivity,
} from './activity-github-pull-request';
import {
  ensureProjectStatusOptionsActivity,
  getTopBacklogIssueActivity,
  getTopReadyIssueActivity,
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

    async openPullRequest(input: OpenPullRequestInput): Promise<CreatedPullRequest> {
      return openPullRequestActivity(deps, input);
    },

    async listIssueComments(input: ListIssueCommentsInput): Promise<IssueComment[]> {
      return listIssueCommentsActivity(deps, input);
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