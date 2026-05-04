import { getAgentSchema } from '../agent-schema-registry';
import type { RequestedAgentProviderSelection } from '../agent-provider';
import { wrapUntrustedInput } from '../phases/prompt-hardening';
import { buildSpecifyChangeName, buildSpecifyPrompt, SPECIFY_SYSTEM_PROMPT } from '../phases/specify/prompt';
import {
  formatJudgeFeedback,
  normalizeLiveJudgeMaxRevisions,
  runLiveJudge,
  SPECIFY_LIVE_JUDGE_SYSTEM_PROMPT,
  summariseJudgeReports,
  type LiveJudgeAttempt,
  type LiveJudgeOptions,
} from './live-judge';
import { toErrorMessage } from './replay-common';
import {
  evaluateSpecifyResponse,
  SPECIFY_REPLAY_SCHEMA_ID,
  summariseSpecifyReplayResults,
  type SpecifyReplayFixture,
  type SpecifyReplayResult,
  type SpecifyReplaySuiteResult,
} from './specify-replay';
import {
  addRecordedUsage,
  buildLiveEvalComments,
  buildLiveEvalIssue,
  createDefaultLiveTurnRunner,
  mergeRequestedProviderConfig,
  type LiveTurnResult,
  type LiveTurnRunner,
} from './live-common';

export interface SpecifyLiveSuiteOptions extends RequestedAgentProviderSelection {
  worktreePath: string;
  turnRunner?: LiveTurnRunner;
  timeoutMs?: number;
  judge?: LiveJudgeOptions;
  onGeneratorResult?: (fixture: SpecifyReplayFixture, result: LiveTurnResult) => void;
}

function buildSpecifyJudgePrompt(
  basePrompt: string,
  candidateResponse: string,
  result: SpecifyReplayResult,
): string {
  return [
    'Original specify prompt:',
    wrapUntrustedInput('specify-prompt', basePrompt),
    '',
    'Candidate response JSON:',
    wrapUntrustedInput('candidate-response', candidateResponse),
    '',
    'Observed eval result:',
    wrapUntrustedInput('specify-eval-result', JSON.stringify({
      status: result.status,
      openQuestionsCount: result.openQuestionsCount,
      assumptionsCount: result.assumptionsCount,
      risksCount: result.risksCount,
      filesCount: result.filesCount,
      errorMessage: result.errorMessage,
      expectationMismatch: result.expectationMismatch,
    }, null, 2)),
    '',
    'Return only structured output as JSON with:',
    '- verdict: "pass" or "revise"',
    '- summary: one concise operator-readable explanation',
    '- issues: array of { code, message } entries',
    '',
    'Choose pass only when the response is reviewable as written, addresses the issue, and uses openQuestions only for genuine blockers.',
    'Choose revise when the response misses scope, leaves avoidable ambiguity, or still needs a clearer definition of done.',
  ].join('\n');
}

function buildSpecifyRevisionPrompt(basePrompt: string, candidateResponse: string, critique: string): string {
  return [
    basePrompt,
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
  const judgeTurnRunner = options.judge?.turnRunner ?? turnRunner;
  const schemaDefinition = getAgentSchema(SPECIFY_REPLAY_SCHEMA_ID);
  const basePrompt = buildSpecifyPrompt({
    issue,
    changeName,
    issueComments: buildLiveEvalComments(fixture.operatorComments),
    currentDraftFiles: fixture.priorDraft,
  });
  let prompt = basePrompt;
  let totalUsage;
  let totalCostMicroUsd = 0;
  let result: SpecifyReplayResult;
  let finalText: string | undefined;
  let attempt = 1;
  let revisionCount = 0;
  const maxRevisions = normalizeLiveJudgeMaxRevisions(options.judge?.maxRevisions);
  const judgeAttempts: LiveJudgeAttempt[] = [];

  for (;;) {
    try {
      const turn = await turnRunner({
        worktreePath: options.worktreePath,
        prompt,
        systemPrompt: SPECIFY_SYSTEM_PROMPT,
        outputSchema: schemaDefinition.jsonSchema,
        parseOutput: (value) => schemaDefinition.schema.parse(value),
        timeoutMs: options.timeoutMs,
        provider: options.provider,
        config: options.config,
      });
      totalUsage = addRecordedUsage(totalUsage, turn.usage);
      totalCostMicroUsd += turn.costMicroUsd ?? 0;
      finalText = turn.finalText;
      result = evaluateSpecifyResponse(fixture, {
        finalText,
        usage: totalUsage,
        costMicroUsd: totalCostMicroUsd,
      });
      options.onGeneratorResult?.(fixture, {
        finalText,
        ...(totalUsage ? { usage: totalUsage } : {}),
        costMicroUsd: totalCostMicroUsd,
      });
    } catch (error) {
      result = evaluateSpecifyResponse(fixture, {
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
      prompt: buildSpecifyJudgePrompt(basePrompt, finalText, result),
      turnRunner: judgeTurnRunner,
      timeoutMs: options.timeoutMs,
      systemPrompt: SPECIFY_LIVE_JUDGE_SYSTEM_PROMPT,
      provider: options.judge?.provider ?? options.provider,
      config: mergeRequestedProviderConfig(options.config, options.judge?.config),
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
    attempt += 1;
    prompt = buildSpecifyRevisionPrompt(basePrompt, finalText, formatJudgeFeedback(judge.parsedVerdict));
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
  const judgeSummary = summariseJudgeReports(results);

  return {
    schemaId: SPECIFY_REPLAY_SCHEMA_ID,
    results,
    summary: summariseSpecifyReplayResults(results),
    ...(judgeSummary ? { judgeSummary } : {}),
  };
}