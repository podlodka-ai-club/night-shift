import { getAgentSchema } from '../agent-schema-registry';
import { buildChangeName } from '../phases/change-name';
import { buildImplementPrompt, IMPLEMENT_SYSTEM_PROMPT } from '../phases/implement/prompt';
import { type OpenPullRequestFeedback } from '../shared';
import { toErrorMessage } from './replay-common';
import {
  evaluateImplementResponse,
  IMPLEMENT_REPLAY_SCHEMA_ID,
  summariseImplementReplayResults,
  type ImplementReplayFixture,
  type ImplementReplayResult,
  type ImplementReplaySuiteResult,
} from './implement-replay';
import { buildLiveEvalComments, buildLiveEvalIssue, createDefaultLiveTurnRunner, type LiveTurnRunner } from './live-common';

export interface ImplementLiveSuiteOptions {
  worktreePath: string;
  turnRunner?: LiveTurnRunner;
  timeoutMs?: number;
}

const EMPTY_PULL_REQUEST_FEEDBACK: OpenPullRequestFeedback = {
  reviewBodies: [],
  reviewComments: [],
};

export async function runImplementLiveFixture(
  fixture: ImplementReplayFixture,
  options: ImplementLiveSuiteOptions,
): Promise<ImplementReplayResult> {
  if (!(fixture as Partial<ImplementReplayFixture>).ticket) {
    return evaluateImplementResponse(fixture, {
      missingResponseErrorMessage: 'Live mode requires fixture.ticket to build the implement prompt.',
    });
  }

  const issue = buildLiveEvalIssue(fixture.id, fixture.ticket.title, fixture.ticket.description);
  const changeName = buildChangeName(issue);
  const turnRunner = options.turnRunner ?? createDefaultLiveTurnRunner();

  try {
    const turn = await turnRunner({
      worktreePath: options.worktreePath,
      prompt: buildImplementPrompt({
        issue,
        changeName,
        specBundleFiles: fixture.specBundle,
        issueComments: buildLiveEvalComments(fixture.operatorComments),
        pullRequestFeedback: EMPTY_PULL_REQUEST_FEEDBACK,
      }),
      systemPrompt: IMPLEMENT_SYSTEM_PROMPT,
      outputSchema: getAgentSchema(IMPLEMENT_REPLAY_SCHEMA_ID).jsonSchema,
      timeoutMs: options.timeoutMs,
    });
    return evaluateImplementResponse(fixture, {
      finalText: turn.finalText,
      usage: turn.usage,
      costMicroUsd: turn.costMicroUsd,
    });
  } catch (error) {
    return evaluateImplementResponse(fixture, {
      missingResponseErrorMessage: `Live runner failed: ${toErrorMessage(error)}`,
    });
  }
}

export async function runImplementLiveSuite(
  fixtures: readonly ImplementReplayFixture[],
  options: ImplementLiveSuiteOptions,
): Promise<ImplementReplaySuiteResult> {
  const turnRunner = options.turnRunner ?? createDefaultLiveTurnRunner();
  const results: ImplementReplayResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runImplementLiveFixture(fixture, { ...options, turnRunner }));
  }

  return {
    schemaId: IMPLEMENT_REPLAY_SCHEMA_ID,
    results,
    summary: summariseImplementReplayResults(results),
  };
}