import {
  IMPLEMENT_RESPONSE_OUTPUT_KEY,
  type AgentStep,
  type CreatedPullRequest,
  type IssueComment,
  type MoveProjectItemStatusInput,
  type OpenPullRequestFeedback,
  type OpenSpecChangeFile,
  type QualityGateResult,
  type RepositoryFile,
  type SelectedProjectIssue,
  type WorktreeContext,
} from '../../shared';
import { parseImplementResponse, type ImplementResponse } from './response';
import { ImplementPhaseContractError } from './errors';
import { buildImplementPrompt, type ImplementRetryFeedback } from './prompt';
import { buildChangeName } from '../change-name';

export interface RunImplementPhaseInput {
  issue: SelectedProjectIssue;
  branchPrefix?: string;
  deferBlockedStatus?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunImplementPhaseDeps {
  createWorktreeForIssueIfNeeded: (input: { issue: SelectedProjectIssue; branchPrefix?: string }) => Promise<WorktreeContext>;
  listIssueComments: (input: { repoOwner: string; repoName: string; issueNumber: number }) => Promise<IssueComment[]>;
  listOpenPullRequestFeedback: (input: { worktree: WorktreeContext }) => Promise<OpenPullRequestFeedback>;
  readOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string }) => Promise<OpenSpecChangeFile[]>;
  runAgentSequence: (input: { worktree: WorktreeContext; steps: [AgentStep, ...AgentStep[]] }) => Promise<{ outputs?: Record<string, unknown> }>;
  writeRepositoryFiles: (input: { worktree: WorktreeContext; files: RepositoryFile[] }) => Promise<void>;
  runQualityGate: (input: { worktree: WorktreeContext }) => Promise<QualityGateResult>;
  commitAndPush: (input: { worktree: WorktreeContext; commitMessage?: string }) => Promise<void>;
  openPullRequest: (input: { worktree: WorktreeContext; title?: string; body?: string; draft?: boolean; updateIfExists?: boolean }) => Promise<CreatedPullRequest>;
  upsertIssueComment: (input: { repoOwner: string; repoName: string; issueNumber: number; marker: string; body: string }) => Promise<void>;
  moveProjectItemStatus: (input: MoveProjectItemStatusInput) => Promise<void>;
}

export interface RunImplementPhaseResult {
  outcome: 'pr_opened' | 'needs_input';
  worktree: WorktreeContext;
  changeName: string;
  summaryCommentBody: string;
  pullRequest?: CreatedPullRequest;
}

const MAX_IMPLEMENT_ATTEMPTS = 2;

export async function runImplementPhase(input: RunImplementPhaseInput, deps: RunImplementPhaseDeps): Promise<RunImplementPhaseResult> {
  const changeName = buildChangeName(input.issue);
  const worktree = await deps.createWorktreeForIssueIfNeeded({
    issue: input.issue,
    branchPrefix: input.branchPrefix,
  });
  const issueComments = await deps.listIssueComments({
    repoOwner: input.issue.repoOwner,
    repoName: input.issue.repoName,
    issueNumber: input.issue.issueNumber,
  });
  const specBundleFiles = await deps.readOpenSpecChangeFiles({ worktree, changeName });

  if (!hasApprovedSpecBundle(specBundleFiles)) {
    const summaryCommentBody = buildMissingSpecSummaryComment(input.issue, changeName, specBundleFiles);
    await deps.upsertIssueComment({
      repoOwner: input.issue.repoOwner,
      repoName: input.issue.repoName,
      issueNumber: input.issue.issueNumber,
      marker: 'implement:summary',
      body: summaryCommentBody,
    });
    if (!input.deferBlockedStatus) {
      await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
    }
    return { outcome: 'needs_input', worktree, changeName, summaryCommentBody };
  }

  const pullRequestFeedback = await deps.listOpenPullRequestFeedback({ worktree });

  input.onProgress?.(`Moving issue #${input.issue.issueNumber} into In progress for Implement.`);
  await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.inProgressOptionId));

  let retryFeedback: ImplementRetryFeedback | undefined;
  let latestResponse: ImplementResponse | undefined;

  for (let attempt = 1; attempt <= MAX_IMPLEMENT_ATTEMPTS; attempt += 1) {
    try {
      latestResponse = await generateImplementResponse(deps, worktree, input.issue, changeName, issueComments, pullRequestFeedback, specBundleFiles, retryFeedback);
    } catch (error) {
      if (!(error instanceof ImplementPhaseContractError)) throw error;
      const summaryCommentBody = buildDeterministicFailureSummaryComment(input.issue, changeName, error.message);
      await deps.upsertIssueComment({
        repoOwner: input.issue.repoOwner,
        repoName: input.issue.repoName,
        issueNumber: input.issue.issueNumber,
        marker: 'implement:summary',
        body: summaryCommentBody,
      });
      if (!input.deferBlockedStatus) {
        await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
      }
      return { outcome: 'needs_input', worktree, changeName, summaryCommentBody };
    }

    await deps.writeRepositoryFiles({ worktree, files: latestResponse.filesWritten });
    const gateResult = await deps.runQualityGate({ worktree });
    if (gateResult.passed) {
      const summaryCommentBody = buildSuccessSummaryComment(input.issue, changeName, latestResponse, gateResult);
      await deps.commitAndPush({ worktree, commitMessage: latestResponse.commitMessage });
      const pullRequest = await deps.openPullRequest({
        worktree,
        title: `#${input.issue.issueNumber}: ${input.issue.issueTitle}`,
        body: buildPullRequestBody(input.issue, latestResponse),
        updateIfExists: true,
      });
      await deps.upsertIssueComment({
        repoOwner: input.issue.repoOwner,
        repoName: input.issue.repoName,
        issueNumber: input.issue.issueNumber,
        marker: 'implement:summary',
        body: summaryCommentBody,
      });
      await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.inReviewOptionId));
      return { outcome: 'pr_opened', worktree, changeName, pullRequest, summaryCommentBody };
    }

    retryFeedback = {
      attempt,
      failure: buildRetryFailureMessage(gateResult),
    };
  }

  const summaryCommentBody = buildNeedsInputSummaryComment(input.issue, changeName, latestResponse, retryFeedback?.failure ?? 'Quality gate failed.');
  await deps.upsertIssueComment({
    repoOwner: input.issue.repoOwner,
    repoName: input.issue.repoName,
    issueNumber: input.issue.issueNumber,
    marker: 'implement:summary',
    body: summaryCommentBody,
  });
  if (!input.deferBlockedStatus) {
    await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
  }
  return { outcome: 'needs_input', worktree, changeName, summaryCommentBody };
}

async function generateImplementResponse(
  deps: RunImplementPhaseDeps,
  worktree: WorktreeContext,
  issue: SelectedProjectIssue,
  changeName: string,
  issueComments: readonly IssueComment[],
  pullRequestFeedback: OpenPullRequestFeedback,
  specBundleFiles: readonly OpenSpecChangeFile[],
  retryFeedback: ImplementRetryFeedback | undefined,
): Promise<ImplementResponse> {
  try {
    const steps: [AgentStep, ...AgentStep[]] = [{
      id: 'implement',
      kind: 'structured',
      prompt: buildImplementPrompt({ issue, changeName, specBundleFiles, issueComments, pullRequestFeedback, retryFeedback }),
      schemaId: 'implement-response-v1',
      resultKey: IMPLEMENT_RESPONSE_OUTPUT_KEY,
    }];
    const result = await deps.runAgentSequence({ worktree, steps });

    try {
      return parseImplementResponse(result.outputs?.[IMPLEMENT_RESPONSE_OUTPUT_KEY]);
    } catch (error) {
      if (error instanceof Error && /invalid/i.test(error.message)) {
        throw new ImplementPhaseContractError(error.message, error);
      }
      throw error;
    }
  } catch (error) {
    const contractError = findErrorInCauseChain(error, (candidate) => (
      candidate.name === 'AgentContractError' || candidate.type === 'AgentContractError'
    ));
    if (contractError) {
      throw new ImplementPhaseContractError(
        typeof contractError.message === 'string' ? contractError.message : describeUnknownError(error),
        error,
      );
    }
    throw error;
  }
}

function findErrorInCauseChain(
  error: unknown,
  predicate: (candidate: { name?: unknown; type?: unknown; message?: unknown; cause?: unknown }) => boolean,
): { name?: unknown; type?: unknown; message?: unknown; cause?: unknown } | undefined {
  const visited = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { name?: unknown; type?: unknown; cause?: unknown };
    if (predicate(candidate)) {
      return candidate;
    }
    current = candidate.cause;
  }

  return undefined;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasApprovedSpecBundle(files: readonly OpenSpecChangeFile[]): boolean {
  const paths = new Set(files.map((file) => file.path));
  return paths.has('proposal.md') && paths.has('tasks.md');
}

function buildMissingSpecSummaryComment(issue: SelectedProjectIssue, changeName: string, files: readonly OpenSpecChangeFile[]): string {
  const paths = files.map((file) => file.path);
  const missing = ['proposal.md', 'tasks.md'].filter((requiredPath) => !paths.includes(requiredPath));
  return [
    `## Implement summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    `- Status: blocked before implementation`,
    `- Missing required spec files: ${missing.join(', ')}`,
    '- Operator guidance: send the item back through Specify and approve a complete spec bundle before retrying Implement.',
  ].join('\n');
}

function buildDeterministicFailureSummaryComment(issue: SelectedProjectIssue, changeName: string, detail: string): string {
  return [
    `## Implement summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    '- Status: blocked on deterministic implement contract failure',
    `- Failure: ${detail}`,
  ].join('\n');
}

function buildSuccessSummaryComment(
  issue: SelectedProjectIssue,
  changeName: string,
  response: ImplementResponse,
  gateResult: QualityGateResult,
): string {
  return [
    `## Implement summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    `- Summary: ${response.summary}`,
    `- Follow-ups: ${response.followUps.length === 0 ? 'none' : response.followUps.join('; ')}`,
    `- Quality gate: ${gateResult.summary}`,
  ].join('\n');
}

function buildNeedsInputSummaryComment(
  issue: SelectedProjectIssue,
  changeName: string,
  response: ImplementResponse | undefined,
  failure: string,
): string {
  return [
    `## Implement summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    `- Summary: ${response?.summary ?? 'Implementation did not complete.'}`,
    `- Follow-ups: ${response?.followUps.length ? response.followUps.join('; ') : 'none'}`,
    `- Needs input: ${failure}`,
  ].join('\n');
}

function buildPullRequestBody(issue: SelectedProjectIssue, response: ImplementResponse): string {
  return [
    `Closes ${issue.issueUrl}`,
    '',
    '> Generated by the Night Shift Implement phase.',
    '',
    '## Summary',
    response.summary,
    '',
    '## Follow-ups',
    response.followUps.length === 0 ? '- none' : response.followUps.map((followUp) => `- ${followUp}`).join('\n'),
  ].join('\n');
}

function buildRetryFailureMessage(gateResult: QualityGateResult): string {
  return [gateResult.summary, gateResult.logs].filter(Boolean).join(': ');
}

function buildStatusUpdateInput(issue: SelectedProjectIssue, statusOptionId: string): MoveProjectItemStatusInput {
  return { projectId: issue.projectId, projectItemId: issue.projectItemId, statusFieldId: issue.statusFieldId, statusOptionId };
}