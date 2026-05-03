import path from 'node:path';
import { runAgentTurnWithHeartbeat, runStructuredAgentTurn } from '../activity-agent-turn';
import { createActivityDependencies } from '../activities';
import { createCodexAgentAdapter, type AgentProgressEvent, type AgentSession, type AgentTurnResult } from '../activity-deps';
import type { IssueComment, SelectedProjectIssue } from '../shared';
import { recordedUsageSchema, type RecordedUsage } from './replay-common';

export interface LiveTurnRequest {
  worktreePath: string;
  prompt: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  parseOutput?: (value: unknown) => unknown;
  timeoutMs?: number;
}

export interface LiveTurnResult {
  finalText: string;
  usage?: RecordedUsage;
  costMicroUsd?: number;
}

export type LiveTurnRunner = (request: LiveTurnRequest) => Promise<LiveTurnResult>;

interface DefaultLiveTurnRunnerDeps {
  createSession: (worktreePath: string) => AgentSession;
  heartbeat: (details: unknown) => void;
  getCancellationSignal: () => AbortSignal | undefined;
}

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

export function createDefaultLiveTurnRunner(deps: DefaultLiveTurnRunnerDeps = createDefaultLiveTurnRunnerDeps()): LiveTurnRunner {
  const heartbeatDeps = {
    heartbeat: deps.heartbeat,
    getCancellationSignal: deps.getCancellationSignal,
  };

  return async (request) => {
    const worktreePath = path.resolve(request.worktreePath);
    const session = deps.createSession(worktreePath);
    let usageFromEvents: RecordedUsage | undefined;
    const timeoutSignal = request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
    const turnDeps = {
      heartbeat: heartbeatDeps.heartbeat,
      getCancellationSignal: () => mergeAbortSignals(heartbeatDeps.getCancellationSignal(), timeoutSignal),
    };
    const handleEvent = (event: AgentProgressEvent) => {
      const usage = parseUsageFromEvent(event);
      if (usage) {
        usageFromEvents = addRecordedUsage(usageFromEvents, usage);
      }
    };

    if (request.outputSchema !== undefined && request.parseOutput) {
      const structuredTurns: AgentTurnResult[] = [];
      const structuredSession: AgentSession = {
        id: session.id,
        run: async (prompt, options) => {
          const turn = await session.run(prompt, options);
          structuredTurns.push(turn);
          return turn;
        },
      };
      const turn = await runStructuredAgentTurn(turnDeps, structuredSession, {
        stepId: 'live-eval',
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        contract: {
          jsonSchema: request.outputSchema,
          parse: request.parseOutput,
        },
        getCheckpointDetails: () => buildLiveTurnCheckpoint(session),
        onEvent: handleEvent,
      });
      const usage = aggregateUsageFromTurns(structuredTurns) ?? usageFromEvents;
      const costMicroUsd = sumTurnCost(structuredTurns);

      return {
        finalText: turn.finalResponse,
        ...(usage ? { usage } : {}),
        ...(typeof costMicroUsd === 'number' ? { costMicroUsd } : {}),
      };
    }

    const signal = turnDeps.getCancellationSignal();
    const turn = await runAgentTurnWithHeartbeat(
      turnDeps,
      session,
      request.prompt,
      {
        outputSchema: request.outputSchema,
        systemPrompt: request.systemPrompt,
        ...(signal ? { signal } : {}),
        onEvent: handleEvent,
      },
      () => buildLiveTurnCheckpoint(session),
    );
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

function createDefaultLiveTurnRunnerDeps(): DefaultLiveTurnRunnerDeps {
  const deps = createActivityDependencies();
  const adapter = createCodexAgentAdapter(deps);
  return {
    createSession: (worktreePath) => adapter.createSession(worktreePath),
    heartbeat: deps.heartbeat,
    getCancellationSignal: deps.getCancellationSignal,
  };
}

function buildLiveTurnCheckpoint(session: AgentSession): { threadId?: string; completedStepIds: string[]; outputs: Record<string, never> } {
  return {
    ...(session.id ? { threadId: session.id } : {}),
    completedStepIds: [],
    outputs: {},
  };
}

function aggregateUsageFromTurns(turns: readonly AgentTurnResult[]): RecordedUsage | undefined {
  let total: RecordedUsage | undefined;
  for (const turn of turns) {
    const usage = parseUsageFromTurn(turn);
    if (!usage) {
      return undefined;
    }
    total = addRecordedUsage(total, usage);
  }
  return total;
}

function sumTurnCost(turns: readonly AgentTurnResult[]): number | undefined {
  let sawCost = false;
  let totalCostMicroUsd = 0;
  for (const turn of turns) {
    if (typeof turn.costMicroUsd === 'number') {
      sawCost = true;
      totalCostMicroUsd += turn.costMicroUsd;
    }
  }
  return sawCost ? totalCostMicroUsd : undefined;
}

function mergeAbortSignals(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  if (left && right) {
    return AbortSignal.any([left, right]);
  }
  return left ?? right;
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