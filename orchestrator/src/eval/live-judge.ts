import { z } from 'zod';
import type { RequestedAgentProviderSelection } from '../agent-provider';
import type { LiveTurnRunner } from './live-common';
import { totalRecordedTokens, toErrorMessage, ZERO_RECORDED_USAGE } from './replay-common';

const liveJudgeVerdictSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  summary: z.string().min(1),
  issues: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  })).default([]),
});

export type LiveJudgeVerdict = z.infer<typeof liveJudgeVerdictSchema>;
export type LiveJudgeFinalVerdict = LiveJudgeVerdict['verdict'] | 'error';

export interface LiveJudgeAttempt {
  attempt: number;
  verdict: LiveJudgeFinalVerdict;
  issues: LiveJudgeVerdict['issues'];
  costMicroUsd: number;
  totalTokens: number;
  summary?: string;
  errorMessage?: string;
}

export interface LiveJudgeReport {
  maxRevisions: number;
  revisionCount: number;
  finalVerdict: LiveJudgeFinalVerdict;
  attempts: LiveJudgeAttempt[];
}

export interface LiveJudgeSummary {
  totalFixtures: number;
  byVerdict: Record<LiveJudgeFinalVerdict, number>;
  totalJudgeCostMicroUsd: number;
  totalJudgeTokens: number;
  totalRevisions: number;
}

export interface LiveJudgeOptions extends RequestedAgentProviderSelection {
  maxRevisions?: number;
  turnRunner?: LiveTurnRunner;
}

export const MAX_LIVE_JUDGE_REVISIONS = 2;

export function normalizeLiveJudgeMaxRevisions(maxRevisions: number | undefined): number {
  if (typeof maxRevisions !== 'number' || !Number.isFinite(maxRevisions)) {
    return 0;
  }

  return Math.min(MAX_LIVE_JUDGE_REVISIONS, Math.max(0, Math.trunc(maxRevisions)));
}

interface RunLiveJudgeInput {
  attempt: number;
  worktreePath: string;
  prompt: string;
  turnRunner: LiveTurnRunner;
  timeoutMs?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
}

export async function runLiveJudge(
  input: RunLiveJudgeInput,
): Promise<{ attempt: LiveJudgeAttempt; parsedVerdict?: LiveJudgeVerdict }> {
  try {
    const turn = await input.turnRunner({
      worktreePath: input.worktreePath,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      timeoutMs: input.timeoutMs,
      provider: input.provider,
      model: input.model,
    });
    const usage = turn.usage ?? ZERO_RECORDED_USAGE;
    const costMicroUsd = turn.costMicroUsd ?? 0;
    const totalTokens = totalRecordedTokens(usage);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(turn.finalText);
    } catch (error) {
      return {
        attempt: {
          attempt: input.attempt,
          verdict: 'error',
          issues: [],
          costMicroUsd,
          totalTokens,
          errorMessage: `Judge response was not valid JSON: ${toErrorMessage(error)}`,
        },
      };
    }

    const parsedVerdict = liveJudgeVerdictSchema.safeParse(parsedJson);
    if (!parsedVerdict.success) {
      return {
        attempt: {
          attempt: input.attempt,
          verdict: 'error',
          issues: [],
          costMicroUsd,
          totalTokens,
          errorMessage: `Judge response did not match the expected schema: ${parsedVerdict.error.message}`,
        },
      };
    }

    return {
      attempt: {
        attempt: input.attempt,
        verdict: parsedVerdict.data.verdict,
        summary: parsedVerdict.data.summary,
        issues: parsedVerdict.data.issues,
        costMicroUsd,
        totalTokens,
      },
      parsedVerdict: parsedVerdict.data,
    };
  } catch (error) {
    return {
      attempt: {
        attempt: input.attempt,
        verdict: 'error',
        issues: [],
        costMicroUsd: 0,
        totalTokens: 0,
        errorMessage: `Judge runner failed: ${toErrorMessage(error)}`,
      },
    };
  }
}

export function formatJudgeFeedback(verdict: LiveJudgeVerdict): string {
  const lines = [verdict.summary];
  for (const issue of verdict.issues) {
    lines.push(`- [${issue.code}] ${issue.message}`);
  }
  return lines.join('\n');
}

export function hasJudgeFailure(result: { judge?: LiveJudgeReport }): boolean {
  return result.judge !== undefined && result.judge.finalVerdict !== 'pass';
}

export function summariseJudgeReports(results: ReadonlyArray<{ judge?: LiveJudgeReport }>): LiveJudgeSummary | undefined {
  const reports = results.flatMap((result) => (result.judge ? [result.judge] : []));
  if (reports.length === 0) {
    return undefined;
  }

  const byVerdict: LiveJudgeSummary['byVerdict'] = { pass: 0, revise: 0, error: 0 };
  let totalJudgeCostMicroUsd = 0;
  let totalJudgeTokens = 0;
  let totalRevisions = 0;
  for (const report of reports) {
    byVerdict[report.finalVerdict] += 1;
    totalRevisions += report.revisionCount;
    for (const attempt of report.attempts) {
      totalJudgeCostMicroUsd += attempt.costMicroUsd;
      totalJudgeTokens += attempt.totalTokens;
    }
  }

  return {
    totalFixtures: reports.length,
    byVerdict,
    totalJudgeCostMicroUsd,
    totalJudgeTokens,
    totalRevisions,
  };
}