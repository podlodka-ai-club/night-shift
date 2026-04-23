import { GitHubAdapter } from './GitHubAdapter.js';
import { RunState, RunStage, UsageRecord } from '../types.js';

/**
 * Publishes workflow milestones and cost summaries to GitHub pull requests.
 */
export class ReportPublisher {
  constructor(private readonly github: GitHubAdapter) {}

  /** Builds the initial PR body with all milestones completed up to pr_opened. */
  buildInitialBody(state: RunState, taskSummary: string): string {
    const lines: string[] = [
      `## Feature Factory: ${state.issueTitle ?? state.ticketId}`,
      '',
      state.issueUrl ? `**Issue:** ${state.issueUrl}` : '',
      `**Branch:** \`${state.branch}\``,
      '',
      '## Workflow Progress',
      '',
      '| Stage | Status |',
      '|-------|--------|',
      `| Claimed | ✅ |`,
      `| Specified | ✅ |`,
      `| Implemented | ✅ |`,
      `| Validated | ✅ |`,
      `| PR Opened | ✅ |`,
      `| Reviewed | ⏳ |`,
      `| Completed | ⏳ |`,
      '',
      '## Definition of Done',
      '',
      taskSummary.trim() || '_No task summary available._',
      '',
      '---',
      '_Powered by feature-factory orchestrator_',
    ];
    return lines.filter((l) => l !== null).join('\n');
  }

  /** Appends a milestone comment to the PR for a stage transition. */
  async addMilestone(prNumber: number, stage: RunStage, detail?: string): Promise<void> {
    const stageLabel = stage.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
    const lines = [`## ✅ Stage: ${stageLabel}`];
    if (detail) lines.push('', detail);
    await this.github.addPRComment(prNumber, lines.join('\n'));
  }

  /** Posts a blocked comment to the PR and/or the issue. */
  async addBlockedComment(
    state: RunState,
    reason: string,
    prNumber?: number,
  ): Promise<void> {
    const blockedStage = state.blockedAtStage ?? state.stage;
    const body = [
      `## 🚫 Orchestrator Blocked`,
      '',
      `**Stage:** \`${blockedStage}\``,
      `**Reason:** ${reason}`,
      '',
      'Please review the above and update the ticket, then re-queue by moving it back to **Ready**.',
    ].join('\n');

    if (prNumber) {
      await this.github.addPRComment(prNumber, body);
    }
    if (state.issueNumber) {
      await this.github.postIssueComment(state.issueNumber, body);
    }
  }

  /** Publishes aggregate usage and cost summary as a final PR comment. */
  async publishCostSummary(prNumber: number, usage: UsageRecord[]): Promise<void> {
    const totalCost = usage.reduce((s, r) => s + r.estimatedCostUsd, 0);
    const totalInputTokens = usage.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    const totalOutputTokens = usage.reduce((s, r) => s + (r.outputTokens ?? 0), 0);

    const rows = usage
      .map((r) => `| ${r.step} | ${r.role ?? '-'} | ${r.provider} | ${r.model} | ${r.inputTokens ?? '-'} | ${r.outputTokens ?? '-'} | $${r.estimatedCostUsd.toFixed(4)} |`)
      .join('\n');

    const body = [
      `## 💰 Cost Summary`,
      '',
      `**Total:** $${totalCost.toFixed(4)} | Input tokens: ${totalInputTokens} | Output tokens: ${totalOutputTokens}`,
      '',
      '| Step | Role | Provider | Model | Input | Output | Cost |',
      '|------|------|----------|-------|-------|--------|------|',
      rows,
    ].join('\n');

    await this.github.addPRComment(prNumber, body);
  }
}
