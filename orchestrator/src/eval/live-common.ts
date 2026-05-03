import path from 'node:path';
import { createActivityDependencies } from '../activities';
import { createCodexAgentAdapter, type AgentProgressEvent, type AgentTurnResult } from '../activity-deps';
import type { IssueComment, SelectedProjectIssue } from '../shared';
import { recordedUsageSchema, type RecordedUsage } from './replay-common';

export interface LiveTurnRequest {
  worktreePath: string;
  prompt: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  timeoutMs?: number;
}

export interface LiveTurnResult {
  finalText: string;
  usage?: RecordedUsage;
  costMicroUsd?: number;
}

export type LiveTurnRunner = (request: LiveTurnRequest) => Promise<LiveTurnResult>;

export function addRecordedUsage(left: RecordedUsage | undefined, right: RecordedUsage | undefined): RecordedUsage | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
  };
}

export function createDefaultLiveTurnRunner(): LiveTurnRunner {
  const deps = createActivityDependencies();
  const adapter = createCodexAgentAdapter(deps);

  return async (request) => {
    const worktreePath = path.resolve(request.worktreePath);
    const session = adapter.createSession(worktreePath);
    let usageFromEvents: RecordedUsage | undefined;
    const signal = request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
    const turn = await session.run(request.prompt, {
      outputSchema: request.outputSchema,
      systemPrompt: request.systemPrompt,
      ...(signal ? { signal } : {}),
      onEvent: (event) => {
        const usage = parseUsageFromEvent(event);
        if (usage) {
          usageFromEvents = usage;
        }
      },
    });
    const usage = parseUsageFromTurn(turn) ?? usageFromEvents;

    return {
      finalText: turn.finalResponse,
      ...(usage ? { usage } : {}),
      ...(typeof turn.costMicroUsd === 'number' ? { costMicroUsd: turn.costMicroUsd } : {}),
    };
  };
}

export function buildLiveEvalIssue(fixtureId: string, title: string, description: string): SelectedProjectIssue {
  return {
    projectId: 'eval-project',
    projectItemId: 'eval-item',
    statusFieldId: 'eval-status',
    backlogOptionId: 'eval-backlog',
    refinementOptionId: 'eval-refinement',
    refinedOptionId: 'eval-refined',
    readyOptionId: 'eval-ready',
    inProgressOptionId: 'eval-in-progress',
    inReviewOptionId: 'eval-in-review',
    readyToMergeOptionId: 'eval-ready-to-merge',
    blockedOptionId: 'eval-blocked',
    issueNumber: 1,
    issueTitle: title,
    taskDescription: description,
    issueUrl: `https://example.invalid/eval/${encodeURIComponent(fixtureId)}`,
    repoOwner: 'eval',
    repoName: 'fixture',
    defaultBranch: 'main',
    backlogStatusName: 'Backlog',
    refinementStatusName: 'Refinement',
    refinedStatusName: 'Refined',
    readyStatusName: 'Ready',
    inReviewStatusName: 'In review',
    readyToMergeStatusName: 'Ready to merge',
  };
}

export function buildLiveEvalComments(commentBodies: readonly string[]): IssueComment[] {
  return commentBodies.map((body, index) => ({ id: index + 1, body }));
}

function parseUsageFromEvent(event: AgentProgressEvent): RecordedUsage | undefined {
  if (event.type !== 'usage') {
    return undefined;
  }
  const parsed = recordedUsageSchema.safeParse(event.payload);
  return parsed.success ? parsed.data : undefined;
}

function parseUsageFromTurn(turn: AgentTurnResult): RecordedUsage | undefined {
  const parsed = recordedUsageSchema.safeParse(turn.usage);
  return parsed.success ? parsed.data : undefined;
}