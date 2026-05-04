import {
  SPECIFY_RESPONSE_OUTPUT_KEY,
  resolveEffectivePhaseAgentProviderSelection,
  type AgentStep,
  type CreatedPullRequest,
  type IssueComment,
  type MoveProjectItemStatusInput,
  type OpenSpecChangeFile,
  type ProjectExtensionManifest,
  type RunAgentSequenceInput,
  type SelectedProjectIssue,
  type WorkflowAgentSelections,
  type WorktreeContext,
} from '../../shared';
import { createEmptyProjectExtensionManifest } from '../../project-extension-manifest';
import { parseSpecifyResponse, type SpecifyResponse } from './response';
import { buildSpecifyChangeName, buildSpecifyPrompt, SPECIFY_SYSTEM_PROMPT } from './prompt';
import { SpecifyPhaseContractError } from './errors';

export interface RunSpecifyPhaseInput {
  issue: SelectedProjectIssue;
  agents?: WorkflowAgentSelections;
  branchPrefix?: string;
  deferBlockedStatus?: boolean;
  projectExtensionManifest?: ProjectExtensionManifest;
  onProgress?: (message: string) => void;
}

export interface RunSpecifyPhaseDeps {
  createWorktreeForIssueIfNeeded: (input: { issue: SelectedProjectIssue; branchPrefix?: string }) => Promise<WorktreeContext>;
  listIssueComments: (input: { repoOwner: string; repoName: string; issueNumber: number }) => Promise<IssueComment[]>;
  readOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string }) => Promise<OpenSpecChangeFile[]>;
  writeOpenSpecChangeFiles: (input: { worktree: WorktreeContext; changeName: string; files: OpenSpecChangeFile[] }) => Promise<void>;
  validateOpenSpecChange: (input: { worktree: WorktreeContext; changeName: string }) => Promise<void>;
  loadProjectExtensionManifest?: (input: { worktree: WorktreeContext }) => Promise<ProjectExtensionManifest>;
  runAgentSequence: (input: RunAgentSequenceInput) => Promise<{ outputs?: Record<string, unknown> }>;
  commitAndPush: (input: { worktree: WorktreeContext; commitMessage?: string }) => Promise<void>;
  openPullRequest: (input: { worktree: WorktreeContext; title?: string; body?: string; draft?: boolean; updateIfExists?: boolean }) => Promise<CreatedPullRequest>;
  upsertIssueComment: (input: { repoOwner: string; repoName: string; issueNumber: number; marker: string; body: string }) => Promise<void>;
  moveProjectItemStatus: (input: MoveProjectItemStatusInput) => Promise<void>;
}

export interface RunSpecifyPhaseResult {
  outcome: 'refined' | 'needs_input';
  worktree: WorktreeContext;
  changeName: string;
  projectExtensionManifest: ProjectExtensionManifest;
  pullRequest?: CreatedPullRequest;
  summaryCommentBody: string;
}

export async function runSpecifyPhase(input: RunSpecifyPhaseInput, deps: RunSpecifyPhaseDeps): Promise<RunSpecifyPhaseResult> {
  const changeName = buildSpecifyChangeName(input.issue);
  input.onProgress?.(`Moving issue #${input.issue.issueNumber} into ${input.issue.refinementStatusName}.`);
  await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.refinementOptionId));
  const worktree = await deps.createWorktreeForIssueIfNeeded({ issue: input.issue, branchPrefix: input.branchPrefix });
  const projectExtensionManifest = input.projectExtensionManifest
    ?? await deps.loadProjectExtensionManifest?.({ worktree })
    ?? createEmptyProjectExtensionManifest();
  const providerSelection = resolveEffectivePhaseAgentProviderSelection('specify', input.agents, projectExtensionManifest);
  const issueComments = await deps.listIssueComments({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, issueNumber: input.issue.issueNumber });
  const currentDraftFiles = await deps.readOpenSpecChangeFiles({ worktree, changeName });
  let specifyResponse = await generateSpecifyResponse(deps, worktree, input.issue, changeName, issueComments, currentDraftFiles, undefined, projectExtensionManifest, providerSelection);
  let validationError: string | undefined;

  await deps.writeOpenSpecChangeFiles({ worktree, changeName, files: specifyResponse.files });
  try {
    await deps.validateOpenSpecChange({ worktree, changeName });
  } catch (error) {
    validationError = toErrorMessage(error);
    specifyResponse = await generateSpecifyResponse(deps, worktree, input.issue, changeName, issueComments, specifyResponse.files, validationError, projectExtensionManifest, providerSelection);
    await deps.writeOpenSpecChangeFiles({ worktree, changeName, files: specifyResponse.files });
    try {
      await deps.validateOpenSpecChange({ worktree, changeName });
    } catch (retryError) {
      throw new Error(`OpenSpec validation still failed after one repair attempt: ${toErrorMessage(retryError)}`);
    }
  }

  const summaryCommentBody = buildSpecifySummaryComment(input.issue, changeName, specifyResponse, validationError);
  if (specifyResponse.openQuestions.length > 0) {
    await deps.upsertIssueComment({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, issueNumber: input.issue.issueNumber, marker: 'specify:summary', body: summaryCommentBody });
    input.onProgress?.(`Specify phase needs operator input for issue #${input.issue.issueNumber}.`);
    if (!input.deferBlockedStatus) {
      await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.blockedOptionId));
    }
    return { outcome: 'needs_input', worktree, changeName, projectExtensionManifest, summaryCommentBody };
  }

  await deps.commitAndPush({ worktree, commitMessage: `docs(spec): draft OpenSpec change for #${input.issue.issueNumber}` });
  const pullRequest = await deps.openPullRequest({
    worktree,
    title: `Spec: #${input.issue.issueNumber} ${input.issue.issueTitle}`,
    body: buildSpecifyPullRequestBody(input.issue, changeName, summaryCommentBody),
    draft: true,
    updateIfExists: true,
  });
  await deps.upsertIssueComment({ repoOwner: input.issue.repoOwner, repoName: input.issue.repoName, issueNumber: input.issue.issueNumber, marker: 'specify:summary', body: `${summaryCommentBody}\n\nDraft PR: ${pullRequest.pullRequestUrl}` });
  input.onProgress?.(`Specify phase produced a draft PR for issue #${input.issue.issueNumber}.`);
  await deps.moveProjectItemStatus(buildStatusUpdateInput(input.issue, input.issue.refinedOptionId));
  return { outcome: 'refined', worktree, changeName, projectExtensionManifest, pullRequest, summaryCommentBody };
}

async function generateSpecifyResponse(
  deps: RunSpecifyPhaseDeps,
  worktree: WorktreeContext,
  issue: SelectedProjectIssue,
  changeName: string,
  issueComments: readonly IssueComment[],
  currentDraftFiles: readonly OpenSpecChangeFile[],
  validationError: string | undefined,
  projectExtensionManifest: ProjectExtensionManifest,
  providerSelection: RunAgentSequenceInput['providerSelection'],
): Promise<SpecifyResponse> {
  try {
    const steps: [AgentStep, ...AgentStep[]] = [buildSpecifyStep(issue, changeName, issueComments, currentDraftFiles, validationError, projectExtensionManifest)];
    const result = await deps.runAgentSequence({ worktree, steps, ...(providerSelection ? { providerSelection } : {}) });
    return parseSpecifyResponse(result.outputs?.[SPECIFY_RESPONSE_OUTPUT_KEY]);
  } catch (error) {
    if (error instanceof Error && error.name === 'AgentContractError') {
      throw new SpecifyPhaseContractError(error.message);
    }
    throw error;
  }
}

function buildSpecifyStep(
  issue: SelectedProjectIssue,
  changeName: string,
  issueComments: readonly IssueComment[],
  currentDraftFiles: readonly OpenSpecChangeFile[],
  validationError: string | undefined,
  projectExtensionManifest: ProjectExtensionManifest,
): AgentStep {
  return {
    id: 'specify',
    kind: 'structured',
    prompt: buildSpecifyPrompt({
      issue,
      changeName,
      issueComments,
      currentDraftFiles,
      validationError,
      projectExtensionPromptContributions: projectExtensionManifest.prompts.specify,
    }),
    systemPrompt: SPECIFY_SYSTEM_PROMPT,
    schemaId: 'specify-response-v1',
    resultKey: SPECIFY_RESPONSE_OUTPUT_KEY,
  };
}

function buildSpecifySummaryComment(issue: SelectedProjectIssue, changeName: string, response: SpecifyResponse, validationError: string | undefined): string {
  return [
    `## Specify summary for #${issue.issueNumber}`,
    `- Change: \`openspec/changes/${changeName}\``,
    `- Open questions: ${response.openQuestions.length === 0 ? 'none' : response.openQuestions.join('; ')}`,
    `- Assumptions: ${response.assumptions.length === 0 ? 'none' : response.assumptions.join('; ')}`,
    `- Risks: ${response.risks.length === 0 ? 'none' : response.risks.join('; ')}`,
    `- Validation: ${validationError ?? 'passed'}`,
  ].join('\n');
}

function buildSpecifyPullRequestBody(issue: SelectedProjectIssue, changeName: string, summaryCommentBody: string): string {
  return [`Draft OpenSpec change for ${issue.issueUrl}.`, '', `Change folder: \`openspec/changes/${changeName}\``, '', summaryCommentBody].join('\n');
}

function buildStatusUpdateInput(issue: SelectedProjectIssue, statusOptionId: string): MoveProjectItemStatusInput {
  return { projectId: issue.projectId, projectItemId: issue.projectItemId, statusFieldId: issue.statusFieldId, statusOptionId };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}