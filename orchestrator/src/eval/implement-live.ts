import { getAgentSchema } from '../agent-schema-registry';
import { buildChangeName } from '../phases/change-name';
import { buildPromptHardeningPreamble, wrapUntrustedInput } from '../phases/prompt-hardening';
import { buildImplementPrompt, IMPLEMENT_SYSTEM_PROMPT, type ImplementRetryFeedback } from '../phases/implement/prompt';
import { type OpenPullRequestFeedback } from '../shared';
import { formatJudgeFeedback, runLiveJudge, summariseJudgeReports, type LiveJudgeAttempt, type LiveJudgeOptions } from './live-judge';
import { toErrorMessage } from './replay-common';
import {
  evaluateImplementResponse,
  IMPLEMENT_REPLAY_SCHEMA_ID,
  summariseImplementReplayResults,
  type ImplementReplayFixture,
  type ImplementReplayResult,
  type ImplementReplaySuiteResult,
} from './implement-replay';
import { addRecordedUsage, buildLiveEvalComments, buildLiveEvalIssue, createDefaultLiveTurnRunner, type LiveTurnRunner } from './live-common';

export interface ImplementLiveSuiteOptions {
  worktreePath: string;
  turnRunner?: LiveTurnRunner;
  timeoutMs?: number;
  judge?: LiveJudgeOptions;
}

const EMPTY_PULL_REQUEST_FEEDBACK: OpenPullRequestFeedback = {
  reviewBodies: [],
  reviewComments: [],
};

const IMPLEMENT_JUDGE_SYSTEM_PROMPT = buildPromptHardeningPreamble('You are reviewing a live implement eval output for operator-facing quality.');

function buildImplementPromptBase(fixture: ImplementReplayFixture, retryFeedback?: ImplementRetryFeedback): string {
  const issue = buildLiveEvalIssue(fixture.id, fixture.ticket.title, fixture.ticket.description);
  const changeName = buildChangeName(issue);
  return buildImplementPrompt({
    issue,
    changeName,
    specBundleFiles: fixture.specBundle,
    issueComments: buildLiveEvalComments(fixture.operatorComments),
    pullRequestFeedback: EMPTY_PULL_REQUEST_FEEDBACK,
    ...(retryFeedback ? { retryFeedback } : {}),
  });
}

function buildImplementJudgePrompt(
  basePrompt: string,
  candidateResponse: string,
  result: ImplementReplayResult,
): string {
  return [
    'Original implement prompt:',
    wrapUntrustedInput('implement-prompt', basePrompt),
    '',
    'Candidate response JSON:',
    wrapUntrustedInput('candidate-response', candidateResponse),
    '',
    'Observed eval result:',
    wrapUntrustedInput('implement-eval-result', JSON.stringify({
      status: result.status,
      filesWrittenCount: result.filesWrittenCount,
      totalContentChars: result.totalContentChars,
      commitMessageLength: result.commitMessageLength,
      summaryLength: result.summaryLength,
      followUpsCount: result.followUpsCount,
      errorMessage: result.errorMessage,
      expectationMismatch: result.expectationMismatch,
    }, null, 2)),
    '',
    'Return only structured output as JSON with:',
    '- verdict: "pass" or "revise"',
    '- summary: one concise operator-readable explanation',
    '- issues: array of { code, message } entries',
    '',
    'Choose pass only when the response is reviewable as written, stays in scope, and makes the implementation intent easy to review.',
    'Choose revise when the response drifts scope, leaves the acceptance mapping unclear, or needs clearer follow-up guidance.',
  ].join('\n');
}

function buildImplementRevisionPrompt(
  fixture: ImplementReplayFixture,
  candidateResponse: string,
  critique: string,
  previousAttempt: number,
): string {
  return [
    buildImplementPromptBase(fixture, { attempt: previousAttempt, failure: critique }),
    '',
    'Previous candidate response JSON:',
    wrapUntrustedInput('candidate-response', candidateResponse),
    '',
    'Judge feedback:',
    wrapUntrustedInput('judge-feedback', critique),
    '',
    'Return a full replacement structured response that addresses every issue above.',
  ].join('\n');
}

export async function runImplementLiveFixture(
  fixture: ImplementReplayFixture,
  options: ImplementLiveSuiteOptions,
): Promise<ImplementReplayResult> {
  if (!fixture.ticket) {
    return evaluateImplementResponse(fixture, {
      missingResponseErrorMessage: 'Live mode requires fixture.ticket to build the implement prompt.',
    });
  }

  const issue = buildLiveEvalIssue(fixture.id, fixture.ticket.title, fixture.ticket.description);
  const turnRunner = options.turnRunner ?? createDefaultLiveTurnRunner();
  const judgeTurnRunner = options.judge?.turnRunner ?? turnRunner;
  const basePrompt = buildImplementPrompt({
    issue,
    changeName: buildChangeName(issue),
    specBundleFiles: fixture.specBundle,
    issueComments: buildLiveEvalComments(fixture.operatorComments),
    pullRequestFeedback: EMPTY_PULL_REQUEST_FEEDBACK,
  });
  let prompt = basePrompt;
  let totalUsage;
  let totalCostMicroUsd = 0;
  let result: ImplementReplayResult;
  let finalText: string | undefined;
  let attempt = 1;
  let revisionCount = 0;
  const maxRevisions = Math.max(0, options.judge?.maxRevisions ?? 0);
  const judgeAttempts: LiveJudgeAttempt[] = [];

  while (true) {
    try {
      const turn = await turnRunner({
        worktreePath: options.worktreePath,
        prompt,
        systemPrompt: IMPLEMENT_SYSTEM_PROMPT,
        outputSchema: getAgentSchema(IMPLEMENT_REPLAY_SCHEMA_ID).jsonSchema,
        timeoutMs: options.timeoutMs,
      });
      totalUsage = addRecordedUsage(totalUsage, turn.usage);
      totalCostMicroUsd += turn.costMicroUsd ?? 0;
      finalText = turn.finalText;
      result = evaluateImplementResponse(fixture, {
        finalText,
        usage: totalUsage,
        costMicroUsd: totalCostMicroUsd,
      });
    } catch (error) {
      result = evaluateImplementResponse(fixture, {
        usage: totalUsage,
        costMicroUsd: totalCostMicroUsd,
        missingResponseErrorMessage: `Live runner failed: ${toErrorMessage(error)}`,
      });
      finalText = undefined;
    }

    if (!options.judge || typeof finalText !== 'string') {
      return result;
    }

    const judge = await runLiveJudge({
      attempt,
      worktreePath: options.worktreePath,
      prompt: buildImplementJudgePrompt(basePrompt, finalText, result),
      turnRunner: judgeTurnRunner,
      timeoutMs: options.timeoutMs,
      systemPrompt: IMPLEMENT_JUDGE_SYSTEM_PROMPT,
    });
    judgeAttempts.push(judge.attempt);

    if (!judge.parsedVerdict || judge.parsedVerdict.verdict === 'pass' || revisionCount >= maxRevisions) {
      return {
        ...result,
        judge: {
          maxRevisions,
          revisionCount,
          finalVerdict: judgeAttempts[judgeAttempts.length - 1]?.verdict ?? 'error',
          attempts: judgeAttempts,
        },
      };
    }

    revisionCount += 1;
    prompt = buildImplementRevisionPrompt(fixture, finalText, formatJudgeFeedback(judge.parsedVerdict), attempt);
    attempt += 1;
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
  const judgeSummary = summariseJudgeReports(results);

  return {
    schemaId: IMPLEMENT_REPLAY_SCHEMA_ID,
    results,
    summary: summariseImplementReplayResults(results),
    ...(judgeSummary ? { judgeSummary } : {}),
  };
}