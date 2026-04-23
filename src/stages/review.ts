import * as fs from 'fs';
import * as path from 'path';
import { ValidationRunner } from '../workspace/ValidationRunner.js';
import { ReviewFinding, FIX_RESULT_SCHEMA, FixResult } from '../types.js';
import type { StageContext } from './StageContext.js';

/** Fields required by the review stage. */
type ReviewCtx = Pick<
  StageContext,
  'config' | 'store' | 'runner' | 'workspace' | 'validator' | 'publisher' |
  'ticketId' | 'prNumber' | 'branch' | 'worktreeDir' | 'openspecChangeDir' | 'issueTitle'
> & { prNumber: number };

/**
 * Review stage:
 * 1. Get the diff for the branch.
 * 2. Run the configured reviewer role; normalize to ReviewFinding[].
 * 3. If actionable findings exist, invoke one bounded fix pass via the configured implementer role.
 * 4. Revalidate; update PR.
 */
export async function runReviewStage(ctx: ReviewCtx): Promise<'reviewed' | 'fixed'> {
  const { ticketId, prNumber, branch, worktreeDir } = ctx;
  const runDir = ctx.store.runDir(ticketId);
  const findingsPath = path.join(runDir, 'review-findings.json');
  const fixPath = path.join(runDir, 'review-fix.json');

  function readJsonIfExists<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  // 1. Diff
  const diff = await ctx.workspace.getDiff(worktreeDir, ctx.config.github.defaultBranch);
  if (!diff.trim()) {
    await ctx.publisher.addMilestone(prNumber, 'reviewed', 'No diff to review — run complete.');
    return 'reviewed';
  }

  // 2. Configured review role
  const cached = readJsonIfExists<ReviewFinding[]>(findingsPath);
  let findings: ReviewFinding[];
  if (Array.isArray(cached)) {
    findings = cached;
  } else {
    findings = await ctx.runner.runReview(diff, runDir);
    fs.writeFileSync(findingsPath, JSON.stringify(findings, null, 2));
  }
  const actionable = findings.filter((f) => f.actionable);

  if (actionable.length === 0) {
    await ctx.publisher.addMilestone(
      prNumber,
      'reviewed',
      findings.length > 0
        ? `Review complete — ${findings.length} finding(s), none actionable.`
        : 'Review complete — no findings.',
    );
    return 'reviewed';
  }

  // 3. One bounded fix pass via the configured implementer role
  const fixSummary = actionable
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.summary}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`)
    .join('\n');

  let fixResult = readJsonIfExists<FixResult>(fixPath);
  if (!fixResult || !Array.isArray(fixResult.fixesApplied) || typeof fixResult.summary !== 'string') {
    const fixRaw = await ctx.runner.runRole(
      'implementer',
      `You are fixing code review findings in a repository.\n` +
      `Apply minimal corrections to address each finding below.\n` +
      `Do not refactor unrelated code.\n` +
      `Return structured output with a summary and list of fixes applied.\n\n` +
      `Review findings to fix:\n${fixSummary}\n\nApply fixes now.`,
      'review-fix',
      'review',
      {
        workingDirectory: worktreeDir,
        structuredOutputSchema: FIX_RESULT_SCHEMA as unknown as Record<string, unknown>,
      },
    );

    fixResult = JSON.parse(fixRaw) as FixResult;
    if (!Array.isArray(fixResult.fixesApplied) || typeof fixResult.summary !== 'string') {
      throw new Error('Structured output did not match FIX_RESULT_SCHEMA');
    }
    fs.writeFileSync(fixPath, JSON.stringify(fixResult, null, 2));
  }

  // 4. Revalidate
  const validationResults = await ctx.validator.run(worktreeDir);
  const passed = ValidationRunner.allPassed(validationResults);

  if (passed) {
    await ctx.workspace.commitAndPush(
      worktreeDir,
      branch,
      `fix: address code review findings\n\n${fixSummary}`,
    );
    await ctx.publisher.addMilestone(
      prNumber,
      'fixed',
      `Fixed ${actionable.length} review finding(s) and revalidated.\n\n${fixResult.summary}`,
    );
    return 'fixed';
  } else {
    const failedCmd = validationResults.find((r) => !r.passed);
    throw new Error(
      `Validation failed after review fix: ${failedCmd?.command}\n${failedCmd?.stderr}`,
    );
  }
}
