import { z } from 'zod';
import {
  resolveAgentProviderSelection,
  type RequestedAgentProviderSelection,
} from '../agent-provider';
import { buildPromptHardeningPreamble } from '../phases/prompt-hardening';
import { mergeRequestedProviderConfig, type LiveTurnRunner } from './live-common';
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

export const SPECIFY_LIVE_JUDGE_SYSTEM_PROMPT = buildPromptHardeningPreamble(`You are a strict but fair reviewer of OpenSpec change proposals.

Given a ticket and a candidate spec (proposal.md, tasks.md, optional design.md and surfaced openQuestions / assumptions / risks), decide whether the spec is ready to hand off to an implementer or whether the specifier should revise it.

Rubric (a single failing item is enough to require revision):

  R1. FAITHFULNESS — proposal.md actually addresses the ticket as written
      (no scope drift, no swapping the problem for a different one).
  R2. EVIDENCE     — claims about how the system currently behaves cite a
      file/symbol or are explicitly marked as assumptions. No bare
      "the code does X" without evidence.
  R3. ASSUMPTIONS  — load-bearing assumptions are listed in the assumptions
      array, not buried in prose.
  R4. QUESTIONS    — every entry in openQuestions is a real blocker for
      implementation. Vague curiosity ("could we also...") doesn't count.
  R5. SCOPE        — tasks.md does not pull in unrelated work or feature
      creep beyond the ticket.
  R6. DOD          — proposal.md has a checkable acceptance criterion (or
      definition of done) such that a reviewer could decide pass/fail.

Return strict JSON, no prose:

{
  "verdict": "pass" | "revise",
  "summary": "<short operator-readable verdict; actionable when revise>",
  "issues": [{"code": "R2", "message": "<one sentence, specific>"}]
}

Rules:
- "pass" requires zero issues.
- "revise" requires at least one issue and an actionable summary.
- The summary must tell the specifier what file/section to change when revising.
- Do not invent facts about the codebase. If the spec lacks evidence and has not flagged the gap as an assumption, that itself is an R2 violation.`);

export const IMPLEMENT_LIVE_JUDGE_SYSTEM_PROMPT = buildPromptHardeningPreamble(`You are a strict but fair reviewer of implementer outputs in a spec-driven code-generation system.

You receive: a ticket, the approved spec bundle (proposal.md, tasks.md, optional design.md), optional operator comments, and the implementer's candidate response (a JSON object with filesWritten, commitMessage, summary, followUps).

Decide whether the response is ready for code review or whether the implementer should revise it.

Rubric (a single failing item is enough to require revision):

  R1. FAITHFULNESS    — filesWritten addresses the tasks listed in tasks.md
      and the proposal in proposal.md. No swapping the problem for a
      different one.
  R2. DOD MAPPING     — every acceptance criterion in proposal.md is
      addressed by a concrete change OR explicitly called out in
      summary/followUps as deferred. The summary should make this mapping
      visible (file/section/test name).
  R3. SCOPE           — filesWritten does not pull in unrelated work.
      Tasks marked "maybe" in tasks.md should be deferred to followUps,
      not silently shipped.
  R4. EVIDENCE        — summary's claims about behavior cite a concrete
      artifact (file:line, test name, command output) or are explicitly
      labeled as assumptions. No bare "this works".
  R5. ASSUMPTIONS     — load-bearing assumptions about call sites,
      contracts, or invariants are surfaced in summary or followUps
      (not buried in code comments).
  R6. SELF-ATTACK     — edge cases (empty input, error paths, boundary
      values, regressions in related code) are addressed in code or
      called out in followUps. A blank "no edge cases considered" is a
      violation.

Return strict JSON, no prose:

{
  "verdict": "pass" | "revise",
  "summary": "<short operator-readable verdict; actionable when revise>",
  "issues": [{"code": "R2", "message": "<one sentence, specific>"}]
}

Rules:
- "pass" requires zero issues.
- "revise" requires at least one issue and an actionable summary.
- The summary must tell the implementer what file/section/acceptance criterion to change when revising.
- The fixture is shape-only: the implementer writes files but does NOT run them in a real worktree. Do not require execution evidence (test runs, CI output) — code-level evidence (file paths, test names, cited artifacts) is sufficient.
- Do not invent facts about a real codebase. The bundle and ticket are the ground truth.`);

export function normalizeLiveJudgeMaxRevisions(maxRevisions: number | undefined): number {
  if (typeof maxRevisions !== 'number' || !Number.isFinite(maxRevisions)) {
    return 0;
  }

  return Math.min(MAX_LIVE_JUDGE_REVISIONS, Math.max(0, Math.trunc(maxRevisions)));
}

interface RunLiveJudgeInput extends RequestedAgentProviderSelection {
  attempt: number;
  worktreePath: string;
  prompt: string;
  turnRunner: LiveTurnRunner;
  timeoutMs?: number;
  systemPrompt?: string;
}

export async function runLiveJudge(
  input: RunLiveJudgeInput,
): Promise<{ attempt: LiveJudgeAttempt; parsedVerdict?: LiveJudgeVerdict }> {
  try {
    const selection = resolveAgentProviderSelection(input);
    const turn = await input.turnRunner({
      worktreePath: input.worktreePath,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      timeoutMs: input.timeoutMs,
      provider: selection.provider,
      config: mergeRequestedProviderConfig(input.config, { model: selection.model }),
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