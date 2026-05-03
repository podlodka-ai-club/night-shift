import { getAgentSchema } from '../agent-schema-registry';
import { buildSpecifyChangeName, buildSpecifyPrompt, SPECIFY_SYSTEM_PROMPT } from '../phases/specify/prompt';
import { toErrorMessage } from './replay-common';
import {
  evaluateSpecifyResponse,
  SPECIFY_REPLAY_SCHEMA_ID,
  summariseSpecifyReplayResults,
  type SpecifyReplayFixture,
  type SpecifyReplayResult,
  type SpecifyReplaySuiteResult,
} from './specify-replay';
import { buildLiveEvalComments, buildLiveEvalIssue, createDefaultLiveTurnRunner, type LiveTurnRunner } from './live-common';

export interface SpecifyLiveSuiteOptions {
  worktreePath: string;
  turnRunner?: LiveTurnRunner;
  timeoutMs?: number;
}

export async function runSpecifyLiveFixture(
  fixture: SpecifyReplayFixture,
  options: SpecifyLiveSuiteOptions,
): Promise<SpecifyReplayResult> {
  if (!fixture.ticket) {
    return evaluateSpecifyResponse(fixture, {
      missingResponseErrorMessage: 'Live mode requires fixture.ticket to build the specify prompt.',
    });
  }

  const issue = buildLiveEvalIssue(fixture.id, fixture.ticket.title, fixture.ticket.description);
  const changeName = buildSpecifyChangeName(issue);
  const turnRunner = options.turnRunner ?? createDefaultLiveTurnRunner();

  try {
    const turn = await turnRunner({
      worktreePath: options.worktreePath,
      prompt: buildSpecifyPrompt({
        issue,
        changeName,
        issueComments: buildLiveEvalComments(fixture.operatorComments),
        currentDraftFiles: fixture.priorDraft,
      }),
      systemPrompt: SPECIFY_SYSTEM_PROMPT,
      outputSchema: getAgentSchema(SPECIFY_REPLAY_SCHEMA_ID).jsonSchema,
      timeoutMs: options.timeoutMs,
    });
    return evaluateSpecifyResponse(fixture, {
      finalText: turn.finalText,
      usage: turn.usage,
      costMicroUsd: turn.costMicroUsd,
    });
  } catch (error) {
    return evaluateSpecifyResponse(fixture, {
      missingResponseErrorMessage: `Live runner failed: ${toErrorMessage(error)}`,
    });
  }
}

export async function runSpecifyLiveSuite(
  fixtures: readonly SpecifyReplayFixture[],
  options: SpecifyLiveSuiteOptions,
): Promise<SpecifyReplaySuiteResult> {
  const turnRunner = options.turnRunner ?? createDefaultLiveTurnRunner();
  const results: SpecifyReplayResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runSpecifyLiveFixture(fixture, { ...options, turnRunner }));
  }

  return {
    schemaId: SPECIFY_REPLAY_SCHEMA_ID,
    results,
    summary: summariseSpecifyReplayResults(results),
  };
}