import {
  ESCALATION_RESPONSE_OUTPUT_KEY,
  type AgentStep,
  type CreatedPullRequest,
  type IssueComment,
  type MoveProjectItemStatusInput,
  type OpenSpecChangeFile,
  type PullRequestChangedFile,
  type PullRequestDetails,
  type PullRequestReviewComment,
  type QualityGateResult,
  type RepositoryFile,
  type SelectedProjectIssue,
  type WorkflowBlockedReason,
  type WorkflowPhase,
  type WorktreeContext,
} from '../../shared';
import { buildChangeName } from '../change-name';
import { EscalationPhaseContractError } from './errors';
import { buildEscalationPrompt } from './prompt';
import { parseEscalationResponse, type EscalationResponse } from './response';

export interface RunEscalationPhaseInput {
  issue: SelectedProjectIssue;
  originPhase: WorkflowPhase;
  blockedReason?: WorkflowBlockedReason;
  failureSummary?: string;
  branchPrefix?: string;
  worktree?: WorktreeContext;
  pullRequest?: { pullRequestNumber: number; pullRequestUrl: string };
  onProgress?: (message: string) => void;
}

export interface RunEscalationPhaseDeps {
  createWorktreeForIssueIfNeeded: (input: { issue: SelectedProjectIssue; branchPrefix?: string }) => Promise<WorktreeContext>;
  listIssueComments: (input: { repoOwner: string; repoName: string; issueNumber: number }) => Promise<IssueComment[]>;
  readOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string }) => Promise<OpenSpecChangeFile[]>;
  getPullRequestDetails: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestDetails>;
  getPullRequestDiff: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<string>;
  listPullRequestFiles: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestChangedFile[]>;
  listPullRequestReviewComments: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestReviewComment[]>;
  runAgentSequence: (input: { worktree: WorktreeContext; steps: [AgentStep, ...AgentStep[]]; agentProfile?: 'escalation' | 'default' }) => Promise<{ outputs?: Record<string, unknown> }>;
  writeOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string; files: OpenSpecChangeFile[] }) => Promise<void>;
  writeRepositoryFiles: (input: { worktree: WorktreeContext; files: RepositoryFile[] }) => Promise<void>;
  validateOpenSpecChange: (input: { worktree: WorktreeContext; changeName: string }) => Promise<void>;
  runQualityGate: (input: { worktree: WorktreeContext }) => Promise<QualityGateResult>;
  commitAndPush: (input: { worktree: WorktreeContext; commitMessage?: string }) => Promise<void>;
  openPullRequest: (input: { worktree: WorktreeContext; title?: string; body?: string; draft?: boolean; updateIfExists?: boolean }) => Promise<CreatedPullRequest>;
  upsertIssueComment: (input: { repoOwner: string; repoName: string; issueNumber: number; marker: string; body: string }) => Promise<void>;
  moveProjectItemStatus: (input: MoveProjectItemStatusInput) => Promise<void>;
}

export interface RunEscalationPhaseResult {
  outcome: 'resolved' | 'needs_human';
  worktree: WorktreeContext;
  changeName: string;
  summaryCommentBody: string;
  response?: EscalationResponse;
  resumeStatus?: 'Backlog' | 'Ready' | 'In review';
  pullRequest?: CreatedPullRequest;
}

const MAX_ESCALATION_ATTEMPTS = 2;

export async function runEscalationPhase(input: RunEscalationPhaseInput, deps: RunEscalationPhaseDeps): Promise<RunEscalationPhaseResult> {
  const changeName = buildChangeName(input.issue);
  const worktree = input.worktree ?? await deps.createWorktreeForIssueIfNeeded({ issue: input.issue, branchPrefix: input.branchPrefix });
  const issueComments = await deps.listIssueComments({
    repoOwner: input.issue.repoOwner,
    repoName: input.issue.repoName,
    issueNumber: input.issue.issueNumber,
  });
  const specBundleFiles = await deps.readOpenSpecChangeFiles({ worktree, changeName });
  const reviewContext = input.pullRequest
    ? await loadReviewContext(deps, input.issue, input.pullRequest.pullRequestNumber)
    : undefined;

  let validationError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ESCALATION_ATTEMPTS; attempt += 1) {
    const response = await generateEscalationResponse(
      deps,
      worktree,
      input,
      changeName,
      issueComments,
      specBundleFiles,
      reviewContext,
      validationError,
    );

    if (response.outcome === 'needs_human') {
      const summaryCommentBody = buildHumanNeededComment(input.issue, input.originPhase, response, reviewContext?.pullRequest);
      await deps.upsertIssueComment({
        repoOwner: input.issue.repoOwner,
        repoName: input.issue.repoName,
        issueNumber: input.issue.issueNumber,
        marker: 'escalation:human-needed',
        body: summaryCommentBody,
      });
      await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
      return { outcome: 'needs_human', worktree, changeName, summaryCommentBody, response };
    }

    const normalizedResponse = normalizeResolvedResponse(input.originPhase, response);

    try {
      await applyResolutionFiles(deps, worktree, changeName, input.originPhase, normalizedResponse.resolution.files);
      await validateResolution(deps, worktree, changeName, input.originPhase, normalizedResponse);

      let pullRequest = reviewContext?.pullRequest ? buildCreatedPullRequest(reviewContext.pullRequest, worktree.branchName) : undefined;
      if (normalizedResponse.resolution.files.length > 0) {
        await deps.commitAndPush({ worktree, commitMessage: normalizedResponse.resolution.commitMessage });
        pullRequest = await deps.openPullRequest({
          worktree,
          title: buildPullRequestTitle(input.issue, input.originPhase),
          body: buildPullRequestBody(input.issue, input.originPhase, normalizedResponse),
          draft: input.originPhase === 'specify',
          updateIfExists: true,
        });
      }

      const summaryCommentBody = buildResolvedSummaryComment(input.issue, input.originPhase, normalizedResponse, pullRequest);
      await deps.upsertIssueComment({
        repoOwner: input.issue.repoOwner,
        repoName: input.issue.repoName,
        issueNumber: input.issue.issueNumber,
        marker: 'escalation:summary',
        body: summaryCommentBody,
      });
      await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, statusOptionIdForResumeStatus(input.issue, normalizedResponse.resolution.resumeStatus)));
      return {
        outcome: 'resolved',
        worktree,
        changeName,
        summaryCommentBody,
        response: normalizedResponse,
        resumeStatus: normalizedResponse.resolution.resumeStatus,
        pullRequest,
      };
    } catch (error) {
      validationError = toErrorMessage(error);
      if (attempt === MAX_ESCALATION_ATTEMPTS) {
        const summaryCommentBody = buildRepairExhaustedHumanNeededComment(input.issue, input.originPhase, normalizedResponse, validationError, reviewContext?.pullRequest);
        await deps.upsertIssueComment({
          repoOwner: input.issue.repoOwner,
          repoName: input.issue.repoName,
          issueNumber: input.issue.issueNumber,
          marker: 'escalation:human-needed',
          body: summaryCommentBody,
        });
        await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
        return { outcome: 'needs_human', worktree, changeName, summaryCommentBody, response: normalizedResponse };
      }
    }
  }

  throw new Error('Escalation phase exhausted all attempts without returning a result.');
}

async function generateEscalationResponse(
  deps: RunEscalationPhaseDeps,
  worktree: WorktreeContext,
  input: RunEscalationPhaseInput,
  changeName: string,
  issueComments: readonly IssueComment[],
  specBundleFiles: readonly OpenSpecChangeFile[],
  reviewContext: ReviewContext | undefined,
  validationError: string | undefined,
): Promise<EscalationResponse> {
  try {
    input.onProgress?.(`Running Escalation Manager for ${input.originPhase} on issue #${input.issue.issueNumber}.`);
    const result = await deps.runAgentSequence({
      worktree,
      agentProfile: 'escalation',
      steps: [{
        id: 'escalation',
        kind: 'structured',
        prompt: buildEscalationPrompt({
          issue: input.issue,
          originPhase: input.originPhase,
          blockedReason: input.blockedReason,
          failureSummary: input.failureSummary,
          changeName,
          worktree,
          issueComments,
          specBundleFiles,
          pullRequest: reviewContext?.pullRequest,
          diff: reviewContext?.diff,
          changedFiles: reviewContext?.changedFiles,
          reviewComments: reviewContext?.reviewComments,
          validationError,
        }),
        schemaId: 'escalation-response-v1',
        resultKey: ESCALATION_RESPONSE_OUTPUT_KEY,
      }],
    });
    return parseEscalationResponse(result.outputs?.[ESCALATION_RESPONSE_OUTPUT_KEY]);
  } catch (error) {
    if (error instanceof Error && error.name === 'AgentContractError') {
      throw new EscalationPhaseContractError(error.message, error);
    }

    if (error instanceof EscalationPhaseContractError) {
      return buildFallbackResponse(input.originPhase, `Escalation response contract failure: ${error.message}`);
    }

    if (error instanceof Error) {
      return buildFallbackResponse(input.originPhase, `Escalation agent failed unexpectedly: ${error.message}`);
    }

    return buildFallbackResponse(input.originPhase, `Escalation agent failed unexpectedly: ${String(error)}`);
  }
}

async function loadReviewContext(
  deps: RunEscalationPhaseDeps,
  issue: SelectedProjectIssue,
  pullRequestNumber: number,
): Promise<ReviewContext> {
  const pullRequest = await deps.getPullRequestDetails({
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    pullRequestNumber,
  });
  const diff = await deps.getPullRequestDiff({
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    pullRequestNumber,
  });
  const changedFiles = await deps.listPullRequestFiles({
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    pullRequestNumber,
  });
  const reviewComments = await deps.listPullRequestReviewComments({
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    pullRequestNumber,
  });

  return { pullRequest, diff, changedFiles, reviewComments };
}

async function applyResolutionFiles(
  deps: RunEscalationPhaseDeps,
  worktree: WorktreeContext,
  changeName: string,
  originPhase: WorkflowPhase,
  files: readonly { path: string; content: string }[],
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  if (originPhase === 'specify') {
    await deps.writeOpenSpecChangeFiles({
      worktree,
      changeName,
      files: files.map((file) => ({ path: file.path, content: file.content })),
    });
    return;
  }

  await deps.writeRepositoryFiles({
    worktree,
    files: files.map((file) => ({ path: file.path, content: file.content })),
  });
}

async function validateResolution(
  deps: RunEscalationPhaseDeps,
  worktree: WorktreeContext,
  changeName: string,
  originPhase: WorkflowPhase,
  response: EscalationResponse,
): Promise<void> {
  if (originPhase === 'specify') {
    await deps.validateOpenSpecChange({ worktree, changeName });
    return;
  }

  if (originPhase === 'review' && response.resolution.resumeStatus === 'In review' && response.resolution.files.length === 0) {
    return;
  }

  const result = await deps.runQualityGate({ worktree });
  if (!result.passed) {
    throw new Error(result.logs ? `${result.summary}: ${result.logs}` : result.summary);
  }
}

function buildFallbackResponse(originPhase: WorkflowPhase, detail: string): EscalationResponse {
  return {
    outcome: 'needs_human',
    originPhase,
    confidence: 'low',
    rootCause: {
      category: 'unknown',
      summary: detail,
      evidence: [detail],
    },
    resolution: {
      summary: 'No safe automated repair was applied.',
      files: [],
      validationPlan: [],
      resumeStatus: originPhase === 'specify' ? 'Backlog' : originPhase === 'review' ? 'In review' : 'Ready',
    },
    humanRequest: {
      question: detail,
      recommendedStatusAfterAnswer: originPhase === 'specify' ? 'Backlog' : originPhase === 'review' ? 'In review' : 'Ready',
    },
    issueComment: detail,
  };
}

function normalizeResolvedResponse(originPhase: WorkflowPhase, response: EscalationResponse): EscalationResponse {
  if (response.outcome !== 'resolved') {
    return response;
  }

  const resumeStatus = originPhase === 'specify'
    ? 'Backlog'
    : originPhase === 'implement'
      ? 'Ready'
      : response.resolution.files.length === 0
        ? 'In review'
        : 'Ready';

  return {
    ...response,
    resolution: {
      ...response.resolution,
      resumeStatus,
    },
  };
}

function buildResolvedSummaryComment(
  issue: SelectedProjectIssue,
  originPhase: WorkflowPhase,
  response: EscalationResponse,
  pullRequest: CreatedPullRequest | undefined,
): string {
  return [
    `## Escalation summary for #${issue.issueNumber}`,
    `- Origin phase: ${originPhase}`,
    `- Root cause: ${response.rootCause.summary}`,
    `- Resolution: ${response.resolution.summary}`,
    `- Resume status: ${response.resolution.resumeStatus}`,
    `- Confidence: ${response.confidence}`,
    `- Validation plan: ${response.resolution.validationPlan.length === 0 ? 'none' : response.resolution.validationPlan.join('; ')}`,
    ...(pullRequest ? [`- Pull request: ${pullRequest.pullRequestUrl}`] : []),
  ].join('\n');
}

function buildHumanNeededComment(
  issue: SelectedProjectIssue,
  originPhase: WorkflowPhase,
  response: EscalationResponse,
  pullRequest: PullRequestDetails | undefined,
): string {
  return [
    `## Escalation needs human for #${issue.issueNumber}`,
    `- Origin phase: ${originPhase}`,
    `- Root cause: ${response.rootCause.summary}`,
    `- Human request: ${response.humanRequest?.question ?? 'Operator review required.'}`,
    `- Recommended status after answer: ${response.humanRequest?.recommendedStatusAfterAnswer ?? response.resolution.resumeStatus}`,
    ...(pullRequest ? [`- Pull request: ${pullRequest.pullRequestUrl}`] : []),
  ].join('\n');
}

function buildRepairExhaustedHumanNeededComment(
  issue: SelectedProjectIssue,
  originPhase: WorkflowPhase,
  response: EscalationResponse,
  validationError: string,
  pullRequest: PullRequestDetails | undefined,
): string {
  return [
    `## Escalation needs human for #${issue.issueNumber}`,
    `- Origin phase: ${originPhase}`,
    `- Root cause: ${response.rootCause.summary}`,
    `- Attempted resolution: ${response.resolution.summary}`,
    `- Validation failure: ${validationError}`,
    ...(pullRequest ? [`- Pull request: ${pullRequest.pullRequestUrl}`] : []),
  ].join('\n');
}

function buildPullRequestTitle(issue: SelectedProjectIssue, originPhase: WorkflowPhase): string {
  if (originPhase === 'specify') {
    return `Spec: #${issue.issueNumber} ${issue.issueTitle}`;
  }
  return `#${issue.issueNumber}: ${issue.issueTitle}`;
}

function buildPullRequestBody(issue: SelectedProjectIssue, originPhase: WorkflowPhase, response: EscalationResponse): string {
  return [
    `Escalation recovery for ${issue.issueUrl}.`,
    '',
    `Origin phase: ${originPhase}`,
    '',
    '## Root cause',
    response.rootCause.summary,
    '',
    '## Resolution',
    response.resolution.summary,
  ].join('\n');
}

function buildStatusUpdateInput(issue: SelectedProjectIssue, statusOptionId: string): MoveProjectItemStatusInput {
  return {
    projectId: issue.projectId,
    projectItemId: issue.projectItemId,
    statusFieldId: issue.statusFieldId,
    statusOptionId,
  };
}

function statusOptionIdForResumeStatus(issue: SelectedProjectIssue, resumeStatus: 'Backlog' | 'Ready' | 'In review'): string {
  switch (resumeStatus) {
    case 'Backlog':
      return issue.backlogOptionId;
    case 'Ready':
      return issue.readyOptionId;
    case 'In review':
      return issue.inReviewOptionId;
  }
}

function buildCreatedPullRequest(pullRequest: PullRequestDetails, branchName: string): CreatedPullRequest {
  return {
    branchName,
    pullRequestNumber: pullRequest.pullRequestNumber,
    pullRequestUrl: pullRequest.pullRequestUrl,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ReviewContext {
  pullRequest: PullRequestDetails;
  diff: string;
  changedFiles: PullRequestChangedFile[];
  reviewComments: PullRequestReviewComment[];
}