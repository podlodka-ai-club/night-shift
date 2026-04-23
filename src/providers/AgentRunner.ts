import * as fs from 'fs';
import * as path from 'path';
import { AgentProvider, AgentRole, Config } from '../config.js';
import { RunStore } from '../store/RunStore.js';
import {
  ReviewFinding,
  UsageRecord,
  BudgetExceededError,
  BudgetStage,
  REVIEW_FINDINGS_SCHEMA,
  StructuredOutputError,
} from '../types.js';
import type { ProviderAdapter } from './ProviderAdapter.js';
import { CodexAdapter } from './CodexAdapter.js';
import { ClaudeAdapter } from './ClaudeAdapter.js';

interface RunRoleOptions {
  workingDirectory?: string;
  allowedTools?: string[];
  structuredOutputSchema?: Record<string, unknown>;
}

/**
 * Shared wrapper for all agent invocations:
 * - Role-based routing for planner, implementer, and reviewer
 * - Provider dispatch via ProviderAdapter implementations
 *
 * Responsibilities:
 * - Enforce per-invocation and per-ticket budgets before each call.
 * - Record usage and estimated cost after each call.
 * - Delegate agent inner loops to provider adapters.
 */
export class AgentRunner {
  private readonly adapters = new Map<AgentProvider, ProviderAdapter>();

  constructor(
    private readonly config: Config,
    private readonly store: RunStore,
    private readonly ticketId: string,
  ) {
    // Lazily initialize adapters only for configured providers.
    if (config.codex.enabled && config.codex.apiKey) {
      this.adapters.set('codex', new CodexAdapter(config.codex.apiKey));
    }
    if (config.anthropic.apiKey) {
      this.adapters.set('anthropic', new ClaudeAdapter(config.anthropic.apiKey, config.repoDir));
    }
  }

  // ─── Cost helpers ────────────────────────────────────────────────────────

  private resolvePricing(provider: AgentProvider, model: string) {
    return this.config.pricing.modelOverrides[`${provider}:${model}`]
      ?? (provider === 'codex' ? this.config.pricing.codex : this.config.pricing.anthropic);
  }

  estimateCost(
    provider: AgentProvider,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const pricing = this.resolvePricing(provider, model);
    return (
      (inputTokens / 1000) * pricing.inputPer1kTokens +
      (outputTokens / 1000) * pricing.outputPer1kTokens
    );
  }

  async getTotalCost(): Promise<number> {
    const usage = await this.store.loadUsage(this.ticketId);
    return usage.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  }

  private async getStageCost(stage: BudgetStage): Promise<number> {
    const usage = await this.store.loadUsage(this.ticketId);
    return usage
      .filter((record) => record.budgetStage === stage)
      .reduce((sum, record) => sum + record.estimatedCostUsd, 0);
  }

  async checkBudget(stage: BudgetStage, additionalCost = 0): Promise<void> {
    const total = (await this.getTotalCost()) + additionalCost;
    const stageTotal = (await this.getStageCost(stage)) + additionalCost;
    const stageLimit = this.config.budgets[stage] as number | undefined;
    const totalLimit = this.config.budgets.totalPerTicket;

    if (stageLimit !== undefined && stageTotal > stageLimit) {
      throw new BudgetExceededError(stage, stageLimit, stageTotal);
    }
    if (total > totalLimit) {
      throw new BudgetExceededError('totalPerTicket', totalLimit, total);
    }
  }

  private async record(record: UsageRecord): Promise<void> {
    await this.store.appendUsage(this.ticketId, record);
  }

  private resolveRole(role: AgentRole): Config['agents'][AgentRole] {
    return this.config.agents[role];
  }

  private ensureProviderReady(role: AgentRole, provider: AgentProvider): void {
    if (provider === 'codex') {
      if (!this.config.codex.enabled) {
        throw new Error(`Role "${role}" is configured to use Codex but CODEX_ENABLED=false.`);
      }
      if (!this.config.codex.apiKey) {
        throw new Error(`Role "${role}" is configured to use Codex but OPENAI_API_KEY is not set.`);
      }
      return;
    }

    if (!this.config.anthropic.apiKey) {
      throw new Error(`Role "${role}" is configured to use Anthropic but ANTHROPIC_API_KEY is not set.`);
    }
  }

  // ─── Provider dispatch ───────────────────────────────────────────────────

  /**
   * Runs a prompt through the provider configured for the given logical role.
   * Budget enforcement and usage recording wrap the provider call uniformly.
   */
  async runRole(
    role: AgentRole,
    prompt: string,
    step: string,
    budgetStage: BudgetStage,
    options: RunRoleOptions = {},
  ): Promise<string> {
    const agent = this.resolveRole(role);
    this.ensureProviderReady(role, agent.provider);
    await this.checkBudget(budgetStage);

    const adapter = this.adapters.get(agent.provider);
    if (!adapter) {
      throw new Error(`No adapter available for provider "${agent.provider}"`);
    }

    const start = Date.now();
    const result = await adapter.run({
      prompt,
      model: agent.model,
      role,
      workingDirectory: options.workingDirectory,
      allowedTools: options.allowedTools,
      structuredOutputSchema: options.structuredOutputSchema,
    });

    const cost = result.costUsd || this.estimateCost(
      agent.provider, agent.model, result.inputTokens, result.outputTokens,
    );

    await this.record({
      step,
      role,
      budgetStage,
      provider: agent.provider,
      model: agent.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: cost,
      elapsedMs: Date.now() - start,
      ts: new Date().toISOString(),
    });

    await this.checkBudget(budgetStage);

    return result.text;
  }

  /**
   * Runs a code review via the configured reviewer role with structured output.
   * On failure the raw output is preserved in the run dir and the error is rethrown.
   */
  async runReview(diff: string, runDir: string): Promise<ReviewFinding[]> {
    const prompt =
      'Review the following git diff for a feature implementation. ' +
      'Return your findings as structured output matching the provided schema. ' +
      'Each finding must have severity, summary, and actionable flag. ' +
      'Include file and line when applicable. ' +
      'Return an empty findings array if no issues found.\n\nDiff:\n' +
      diff;

    let rawOutput = '';

    try {
      rawOutput = await this.runRole(
        'reviewer',
        prompt,
        'review-findings',
        'review',
        { structuredOutputSchema: REVIEW_FINDINGS_SCHEMA },
      );
    } catch (err) {
      rawOutput = err instanceof Error ? err.message : String(err);
      fs.writeFileSync(
        path.join(runDir, 'review-error.json'),
        JSON.stringify({ error: true, message: rawOutput }, null, 2),
      );
      throw err;
    }

    fs.writeFileSync(path.join(runDir, 'review-structured.json'), rawOutput);

    try {
      const parsed = JSON.parse(rawOutput) as { findings: ReviewFinding[] };
      if (!Array.isArray(parsed.findings)) {
        throw new StructuredOutputError('Codex review response did not contain a findings array');
      }
      return parsed.findings;
    } catch (err) {
      fs.writeFileSync(
        path.join(runDir, 'review-error.json'),
        JSON.stringify(
          {
            error: true,
            message: err instanceof Error ? err.message : String(err),
            raw: rawOutput,
          },
          null,
          2,
        ),
      );
      throw err;
    }
  }
}
