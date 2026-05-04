import {
  REVIEWER_RESPONSE_OUTPUT_KEY,
  resolveEffectivePhaseAgentProviderSelection,
  type AgentStep,
  type MoveProjectItemStatusInput,
  type OpenSpecChangeFile,
  type ProjectExtensionManifest,
  type PullRequestChangedFile,
  type PullRequestDetails,
  type PullRequestReviewComment,
  type RunAgentSequenceInput,
  type SelectedProjectIssue,
  type WorkflowAgentSelections,
  type WorktreeContext,
} from '../../shared';
import { createEmptyProjectExtensionManifest } from '../../project-extension-manifest';
import { isNightShiftMarkerComment } from '../../comment-markers';
import { buildChangeName } from '../change-name';
import { ReviewPhaseContractError } from './errors';
import { buildReviewPrompt, REVIEWER_SYSTEM_PROMPT } from './prompt';
import { parseReviewerResponse, type Finding, type ReviewerResponse } from './response';

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;
const REVIEW_ESCALATION_LABEL = 'night-shift:escalation';

export type ReviewVerdict = 'ready-to-merge' | 'needs-fix' | 'escalate';

export interface RunReviewPhaseInput {
  issue: SelectedProjectIssue;
  worktree: WorktreeContext;
  pullRequest: { pullRequestNumber: number; pullRequestUrl: string };
  agents?: WorkflowAgentSelections;
  projectExtensionManifest?: ProjectExtensionManifest;
  reviewIteration?: number;
  deferEscalatedStatus?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunReviewPhaseDeps {
  readOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string }) => Promise<OpenSpecChangeFile[]>;
  getPullRequestDetails: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestDetails>;
  getPullRequestDiff: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<string>;
  listPullRequestFiles: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestChangedFile[]>;
  listPullRequestReviewComments: (input: { repoOwner: string; repoName: string; pullRequestNumber: number }) => Promise<PullRequestReviewComment[]>;
  loadProjectExtensionManifest?: (input: { worktree: WorktreeContext }) => Promise<ProjectExtensionManifest>;
  runAgentSequence: (input: RunAgentSequenceInput) => Promise<{ outputs?: Record<string, unknown> }>;
  setPullRequestReady: (input: { repoOwner: string; repoName: string; pullRequestNumber: number; ready: boolean }) => Promise<void>;
  createPullRequestReview: (input: { repoOwner: string; repoName: string; pullRequestNumber: number; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string }) => Promise<void>;
  upsertPullRequestReviewComment: (input: { repoOwner: string; repoName: string; pullRequestNumber: number; commitId: string; marker: string; body: string; path: string; line: number }) => Promise<void>;
  upsertIssueComment: (input: { repoOwner: string; repoName: string; issueNumber: number; marker: string; body: string }) => Promise<void>;
  addIssueLabels: (input: { repoOwner: string; repoName: string; issueNumber: number; labels: string[] }) => Promise<void>;
  moveProjectItemStatus: (input: MoveProjectItemStatusInput) => Promise<void>;
}

export interface RunReviewPhaseResult {
  outcome: 'ready_to_merge' | 'needs_fix' | 'escalated';
  verdict: ReviewVerdict;
  response: ReviewerResponse;
  projectExtensionManifest: ProjectExtensionManifest;
  pullRequestDetails: PullRequestDetails;
  summaryCommentBody: string;
}

export async function runReviewPhase(input: RunReviewPhaseInput, deps: RunReviewPhaseDeps): Promise<RunReviewPhaseResult> {
  const changeName = buildChangeName(input.issue);
  const reviewIteration = input.reviewIteration ?? 0;
  const projectExtensionManifest = input.projectExtensionManifest
    ?? await deps.loadProjectExtensionManifest?.({ worktree: input.worktree })
    ?? createEmptyProjectExtensionManifest();
  const providerSelection = resolveEffectivePhaseAgentProviderSelection('review', input.agents, projectExtensionManifest);
  const pullRequestDetails = await deps.getPullRequestDetails({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, pullRequestNumber: input.pullRequest.pullRequestNumber });
  const specBundleFiles = await deps.readOpenSpecChangeFiles({ worktree: input.worktree, changeName });
  const diff = await deps.getPullRequestDiff({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, pullRequestNumber: input.pullRequest.pullRequestNumber });
  const changedFiles = await deps.listPullRequestFiles({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, pullRequestNumber: input.pullRequest.pullRequestNumber });
  const reviewComments = (await deps.listPullRequestReviewComments({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, pullRequestNumber: input.pullRequest.pullRequestNumber }))
    .filter((comment) => !isNightShiftMarkerComment(comment.body));
  const response = await generateReviewResponse(deps, input, changeName, pullRequestDetails, specBundleFiles, diff, changedFiles, reviewComments, projectExtensionManifest, providerSelection);
  const normalizedResponse = { ...response, findings: normalizeFindingLocations(response.findings, changedFiles, input.worktree) };
  const verdict = decideReviewVerdict(normalizedResponse.findings, reviewIteration, DEFAULT_MAX_REVIEW_ITERATIONS);
  const summaryCommentBody = buildReviewSummaryComment(input.issue, changeName, pullRequestDetails, verdict, normalizedResponse, reviewIteration);

  input.onProgress?.(`Review verdict for PR #${pullRequestDetails.pullRequestNumber}: ${verdict}.`);
  if (verdict === 'ready-to-merge' && pullRequestDetails.isDraft) {
    await deps.setPullRequestReady({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, pullRequestNumber: pullRequestDetails.pullRequestNumber, ready: true });
  }
  await submitPullRequestReview(deps, input.issue, pullRequestDetails, verdict, normalizedResponse, reviewIteration);
  await upsertInlineReviewComments(deps, input.issue, pullRequestDetails, normalizedResponse.findings);
  if (verdict === 'escalate') {
    await deps.addIssueLabels({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, issueNumber: input.issue.issueNumber, labels: [REVIEW_ESCALATION_LABEL] });
  }
  const marker = verdict === 'escalate' ? 'review:escalation' : 'review:summary';
  await deps.upsertIssueComment({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, issueNumber: input.issue.issueNumber, marker, body: summaryCommentBody });
  if (!(verdict === 'escalate' && input.deferEscalatedStatus)) {
    await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, verdict));
  }

  return { outcome: verdictToOutcome(verdict), verdict, response: normalizedResponse, projectExtensionManifest, pullRequestDetails, summaryCommentBody };
}

export function decideReviewVerdict(findings: readonly Finding[], iteration: number, maxReviewIterations = DEFAULT_MAX_REVIEW_ITERATIONS): ReviewVerdict {
  if (!findings.some((finding) => finding.severity === 'error')) return 'ready-to-merge';
  return iteration + 1 < maxReviewIterations ? 'needs-fix' : 'escalate';
}

async function generateReviewResponse(
  deps: RunReviewPhaseDeps,
  input: RunReviewPhaseInput,
  changeName: string,
  pullRequestDetails: PullRequestDetails,
  specBundleFiles: readonly OpenSpecChangeFile[],
  diff: string,
  changedFiles: readonly PullRequestChangedFile[],
  reviewComments: readonly PullRequestReviewComment[],
  projectExtensionManifest: ProjectExtensionManifest,
  providerSelection: RunAgentSequenceInput['providerSelection'],
): Promise<ReviewerResponse> {
  try {
    const result = await deps.runAgentSequence({
      worktree: input.worktree,
      ...(providerSelection ? { providerSelection } : {}),
      steps: [{
        id: 'review',
        kind: 'structured',
        prompt: buildReviewPrompt({
          issue: input.issue,
          changeName,
          pullRequest: pullRequestDetails,
          specBundleFiles,
          diff,
          changedFiles,
          reviewComments,
          projectExtensionPromptContributions: projectExtensionManifest.prompts.review,
        }),
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        schemaId: 'reviewer-response-v1',
        resultKey: REVIEWER_RESPONSE_OUTPUT_KEY,
      }],
    });
    return parseReviewerResponse(result.outputs?.[REVIEWER_RESPONSE_OUTPUT_KEY]);
  } catch (error) {
    const contractError = findErrorInCauseChain(error, (candidate) => candidate.name === 'AgentContractError' || candidate.type === 'AgentContractError');
    if (contractError) {
      throw new ReviewPhaseContractError(typeof contractError.message === 'string' ? contractError.message : describeUnknownError(error), error);
    }
    throw error;
  }
}

function normalizeFindingLocations(findings: readonly Finding[], changedFiles: readonly PullRequestChangedFile[], worktree: WorktreeContext): Finding[] {
  const knownPaths = new Set(changedFiles.map((file) => file.path));
  const worktreeRoot = toPosixPath(worktree.worktreePath).replace(/\/$/, '');
  return findings.map((finding) => {
    if (!finding.location) return finding;
    const rawPath = toPosixPath(finding.location.file);
    const relativePath = isAbsolutePath(rawPath) && rawPath.startsWith(`${worktreeRoot}/`)
      ? rawPath.slice(worktreeRoot.length + 1)
      : rawPath;
    const normalizedPath = knownPaths.has(rawPath)
      ? rawPath
      : knownPaths.has(relativePath)
        ? relativePath
        : changedFiles.find((file) => rawPath.endsWith(`/${file.path}`))?.path;
    return normalizedPath ? { ...finding, location: { ...finding.location, file: normalizedPath } } : finding;
  });
}

async function submitPullRequestReview(
  deps: RunReviewPhaseDeps,
  issue: SelectedProjectIssue,
  pullRequestDetails: PullRequestDetails,
  verdict: ReviewVerdict,
  response: ReviewerResponse,
  reviewIteration: number,
): Promise<void> {
  const desiredEvent = verdict === 'ready-to-merge' ? 'APPROVE' : verdict === 'needs-fix' ? 'REQUEST_CHANGES' : 'COMMENT';
  const body = buildPullRequestReviewBody(issue, pullRequestDetails, verdict, response, reviewIteration);
  try {
    await deps.createPullRequestReview({ repoOwner: issue.repoOwner, repoName: issue.repoName, pullRequestNumber: pullRequestDetails.pullRequestNumber, event: desiredEvent, body });
  } catch (error) {
    if (desiredEvent !== 'COMMENT' && isReviewFallbackError(error)) {
      await deps.createPullRequestReview({ repoOwner: issue.repoOwner, repoName: issue.repoName, pullRequestNumber: pullRequestDetails.pullRequestNumber, event: 'COMMENT', body });
      return;
    }
    throw error;
  }
}

async function upsertInlineReviewComments(
  deps: RunReviewPhaseDeps,
  issue: SelectedProjectIssue,
  pullRequestDetails: PullRequestDetails,
  findings: readonly Finding[],
): Promise<void> {
  for (const finding of findings) {
    if (!finding.location?.line) continue;
    try {
      await deps.upsertPullRequestReviewComment({ repoOwner: issue.repoOwner, repoName: issue.repoName, pullRequestNumber: pullRequestDetails.pullRequestNumber, commitId: pullRequestDetails.headSha, marker: 'review:finding', body: buildInlineCommentBody(finding), path: finding.location.file, line: finding.location.line });
    } catch (error) {
      if (isUnresolvableInlineCommentError(error)) continue;
      throw error;
    }
  }
}

function buildReviewSummaryComment(issue: SelectedProjectIssue, changeName: string, pullRequestDetails: PullRequestDetails, verdict: ReviewVerdict, response: ReviewerResponse, reviewIteration: number): string {
  return [
    `## Review summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    `- Pull request: ${pullRequestDetails.pullRequestUrl}`,
    `- Verdict: ${verdict}`,
    `- Iteration: ${reviewIteration + 1}`,
    `- Summary: ${response.summary}`,
    `- Findings: ${response.findings.length === 0 ? 'none' : response.findings.map(formatFinding).join('; ')}`,
  ].join('\n');
}

function buildPullRequestReviewBody(issue: SelectedProjectIssue, pullRequestDetails: PullRequestDetails, verdict: ReviewVerdict, response: ReviewerResponse, reviewIteration: number): string {
  return [
    `<!-- night-shift:${verdict === 'escalate' ? 'review:escalation' : 'review:summary'} -->`,
    `## Review ${verdict === 'ready-to-merge' ? 'approved' : verdict === 'needs-fix' ? 'requested changes' : 'escalated'} for #${issue.issueNumber}`,
    `PR: ${pullRequestDetails.pullRequestUrl}`,
    `Iteration: ${reviewIteration + 1}`,
    '',
    response.summary,
  ].join('\n');
}

function buildInlineCommentBody(finding: Finding): string {
  return [
    '<!-- night-shift:review:finding -->',
    finding.message,
    ...(finding.specRef ? ['', `Ref: ${finding.specRef}`] : []),
  ].join('\n');
}

function formatFinding(finding: Finding): string {
  const location = finding.location ? ` (${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''})` : '';
  return `${finding.severity}: ${finding.message}${location}`;
}

function buildStatusUpdateInput(issue: SelectedProjectIssue, verdict: ReviewVerdict): MoveProjectItemStatusInput {
  const statusOptionId = verdict === 'ready-to-merge' ? issue.readyToMergeOptionId : verdict === 'needs-fix' ? issue.readyOptionId : issue.blockedOptionId;
  return { projectId: issue.projectId, projectItemId: issue.projectItemId, statusFieldId: issue.statusFieldId, statusOptionId };
}

function verdictToOutcome(verdict: ReviewVerdict): RunReviewPhaseResult['outcome'] {
  return verdict === 'ready-to-merge' ? 'ready_to_merge' : verdict === 'needs-fix' ? 'needs_fix' : 'escalated';
}

function isReviewFallbackError(error: unknown): boolean {
  const message = describeErrorCauseChain(error).toLowerCase();
  return message.includes('your own pull request') || (message.includes('422') && message.includes('review'));
}

function isUnresolvableInlineCommentError(error: unknown): boolean {
  const message = describeErrorCauseChain(error).toLowerCase();
  return message.includes('422') && (
    ((message.includes('path') || message.includes('line')) && message.includes('resolve'))
    || message.includes('commit_id')
    || message.includes('positioning')
    || message.includes('oneof')
    || message.includes('not a permitted key')
  );
}

function findErrorInCauseChain(error: unknown, predicate: (candidate: { name?: unknown; type?: unknown; message?: unknown; cause?: unknown }) => boolean) {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { name?: unknown; type?: unknown; message?: unknown; cause?: unknown };
    if (predicate(candidate)) return candidate;
    current = candidate.cause;
  }
  return undefined;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeErrorCauseChain(error: unknown): string {
  const visited = new Set<unknown>();
  const parts: string[] = [];
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      parts.push(candidate.message);
    }
    current = candidate.cause;
  }

  return parts.join('\n');
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}
