import type {
  AutomateReadyIssueInput,
  CreatedPullRequest,
  IssueCommentInput,
  MoveProjectItemStatusInput,
  OpenPullRequestInput,
  SelectedProjectIssue,
} from './shared';
import type { GitHubActivityDeps } from './activity-deps';
import { commentOnIssueActivity, openPullRequestActivity } from './activity-github-pull-request';
import { getTopReadyIssueActivity, moveProjectItemStatusActivity } from './activity-github-project';

export { buildIssueComment } from './activity-github-pull-request';

export function createGitHubActivities(deps: GitHubActivityDeps) {
  return {
    async getTopReadyIssue(input: AutomateReadyIssueInput): Promise<SelectedProjectIssue> {
      return getTopReadyIssueActivity(deps, input);
    },

    async openPullRequest(input: OpenPullRequestInput): Promise<CreatedPullRequest> {
      return openPullRequestActivity(deps, input);
    },

    async commentOnIssue(input: IssueCommentInput): Promise<void> {
      return commentOnIssueActivity(deps, input);
    },

    async moveProjectItemStatus(input: MoveProjectItemStatusInput): Promise<void> {
      return moveProjectItemStatusActivity(deps, input);
    },
  };
}