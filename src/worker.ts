import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config.js';
import { RunStore } from './store/RunStore.js';
import { RunInspector } from './store/RunInspector.js';
import { GitHubAdapter } from './github/GitHubAdapter.js';
import { AgentRunner } from './providers/AgentRunner.js';
import { RepoWorkspace } from './workspace/RepoWorkspace.js';
import { ValidationRunner } from './workspace/ValidationRunner.js';
import { ReportPublisher } from './github/ReportPublisher.js';
import { resolveResumeState, projectStatusForStage } from './resume.js';
import { runSpecifyStage } from './stages/specify.js';
import { runImplementStage } from './stages/implement.js';
import { runReviewStage } from './stages/review.js';
import { RunState, RunStage, TERMINAL_STAGES } from './types.js';
import { emitRunSummary, buildRunSummary, EmitOptions } from './output/summarizer.js';

const WORKTREE_STAGES: ReadonlySet<RunStage> = new Set([
  'specified', 'implemented', 'validated', 'pr_opened', 'reviewed', 'fixed',
]);

/**
 * Main orchestration worker.
 *
 * On each invocation:
 *  1. Resume any active persisted run, OR
 *  2. Claim the next Ready item from the GitHub Project.
 * Then advance the state machine until terminal or blocked.
 */
export class Worker {
  private readonly store: RunStore;
  private readonly github: GitHubAdapter;
  private readonly workspace: RepoWorkspace;
  private readonly validator: ValidationRunner;
  private readonly inspector: RunInspector;
  private summaryEmitted = false;
  private readonly summaryFormat: EmitOptions['format'];

  constructor(
    private readonly config: Config,
    summaryFormat?: EmitOptions['format'],
  ) {
    this.store = new RunStore(config.dataDir);
    this.github = new GitHubAdapter(config);
    this.workspace = new RepoWorkspace(config.repoDir);
    this.validator = new ValidationRunner();
    this.inspector = new RunInspector(this.store, this.workspace);
    this.summaryFormat = summaryFormat;
  }

  async run(): Promise<void> {
    this.summaryEmitted = false;
    await this.github.initialize();

    const state = await this.claimOrResume();
    if (!state) return;

    await this.advance(state);
  }

  // ─── Claim / Resume ──────────────────────────────────────────────────────

  private async claimOrResume(): Promise<RunState | null> {
    const active = await this.store.listActive();

    if (active.length > 0) {
      for (const candidate of active) {
        try {
          await this.store.lock(candidate.ticketId);
          console.log(`[worker] Resuming run for ticket ${candidate.ticketId} at stage "${candidate.stage}"`);
          return candidate;
        } catch {
          continue;
        }
      }
      console.log('[worker] No resumable unlocked runs found.');
      return null;
    }

    const items = await this.github.listReadyItems();
    const item = items[0] ?? null;
    if (!item) {
      console.log('[worker] No ready items found.');
      return null;
    }

    let state: RunState;

    if (this.store.exists(item.id)) {
      const prev = await this.store.load(item.id);
      const resume = await resolveResumeState(
        prev,
        this.config.github.defaultBranch,
        this.inspector,
        this.workspace,
        (head) => this.github.findOpenPRByHead(head),
      );
      await this.store.update(item.id, {
        stage: resume.stage,
        repoOwner: this.config.github.repoOwner,
        repoName: this.config.github.repoName,
        prNumber: resume.prNumber,
        prUrl: resume.prUrl,
        blockedAtStage: undefined,
        blockedReason: undefined,
      });
      state = await this.store.load(item.id);
      console.log(`[worker] Re-claiming ticket ${state.ticketId}: resuming from "${resume.stage}"`);
    } else {
      const branch = `feature-factory/${item.id.slice(-8)}-${Date.now()}`;
      const worktreeDir = path.resolve(this.config.dataDir, '..', 'worktrees', `${item.id.slice(-8)}-${Date.now()}`);
      state = {
        ticketId: item.id,
        issueNumber: item.issueNumber,
        issueTitle: item.issueTitle,
        issueBody: item.issueBody,
        issueUrl: item.issueUrl,
        repoOwner: this.config.github.repoOwner,
        repoName: this.config.github.repoName,
        branch, worktreeDir,
        stage: 'claimed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.store.create(state);
      console.log(`[worker] Claimed ticket ${state.ticketId}: "${state.issueTitle}"`);
    }

    await this.store.lock(state.ticketId);
    await this.github.updateItemStatus(
      item.id,
      projectStatusForStage(state.stage, this.config.github.statusValues),
    );
    return state;
  }

  // ─── State machine ────────────────────────────────────────────────────────

  private async advance(state: RunState): Promise<void> {
    const runner = new AgentRunner(this.config, this.store, state.ticketId);
    const publisher = new ReportPublisher(this.github);
    const startTime = new Date(state.createdAt);

    while (!TERMINAL_STAGES.has(state.stage)) {
      try {
        await this.step(state, runner, publisher);
        state = await this.store.load(state.ticketId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Stage "${state.stage}" failed: ${reason}`);
        await this.blockRun(state, reason, publisher, state.prNumber);
        state = await this.store.load(state.ticketId);
        await this.emitSummary(state, startTime, runner);
        return;
      }
    }

    console.log(`[worker] Run ${state.ticketId} finished at stage "${state.stage}"`);
    await this.emitSummary(state, startTime, runner);
  }

  private async emitSummary(state: RunState, startTime: Date, runner: AgentRunner): Promise<void> {
    if (this.summaryEmitted) return;
    this.summaryEmitted = true;

    const budget = typeof this.config.budgets.totalPerTicket === 'number'
      ? this.config.budgets.totalPerTicket : undefined;
    const summary = await buildRunSummary(state, startTime, this.store, runner, budget);
    emitRunSummary(process.stdout.write.bind(process.stdout), summary, { format: this.summaryFormat });
  }

  private async step(state: RunState, runner: AgentRunner, publisher: ReportPublisher): Promise<void> {
    if (WORKTREE_STAGES.has(state.stage) && state.worktreeDir && !fs.existsSync(state.worktreeDir)) {
      this.log(state, 'worktree missing, recreating from branch');
      await this.workspace.ensureWorktree(state.branch, state.worktreeDir, this.config.github.defaultBranch);
    }

    this.log(state, `entering stage "${state.stage}"`);
    const baseBranch = this.config.github.defaultBranch;

    switch (state.stage as RunStage) {
      case 'claimed': {
        let changeDir = state.openspecChangeDir;
        if (!changeDir || !this.inspector.isSpecComplete(changeDir)) {
          changeDir = await runSpecifyStage({
            config: this.config, store: this.store, runner,
            ticketId: state.ticketId,
            issueTitle: state.issueTitle ?? state.ticketId,
            issueBody: state.issueBody ?? '',
            repoOwner: state.repoOwner, repoName: state.repoName,
          });
        } else {
          this.log(state, 'OpenSpec artifacts already exist, skipping specify');
        }
        await this.store.update(state.ticketId, { stage: 'specified', openspecChangeDir: changeDir });
        break;
      }

      case 'specified': {
        const worktreeDir = state.worktreeDir!;
        if (!fs.existsSync(worktreeDir)) {
          await this.workspace.setup(state.branch, worktreeDir, baseBranch);
        } else {
          this.log(state, 'worktree already exists, skipping setup');
        }
        if (await this.inspector.hasImplementationProgress(state, baseBranch)) {
          this.log(state, 'implementation artifacts already exist, skipping implement');
          await this.store.update(state.ticketId, { stage: 'implemented' });
          break;
        }
        await runImplementStage({
          config: this.config, store: this.store, runner,
          ticketId: state.ticketId,
          openspecChangeDir: state.openspecChangeDir!, worktreeDir,
          issueTitle: state.issueTitle ?? state.ticketId,
        });
        if (!(await this.inspector.worktreeHasChanges(worktreeDir, baseBranch))) {
          throw new Error('Implementer completed without repository changes. Refusing to advance the workflow.');
        }
        await this.store.update(state.ticketId, { stage: 'implemented' });
        break;
      }

      case 'implemented': {
        const results = await this.validator.run(state.worktreeDir!);
        fs.writeFileSync(
          path.join(this.store.runDir(state.ticketId), 'validation-results.json'),
          JSON.stringify(results, null, 2),
        );
        if (!ValidationRunner.allPassed(results)) {
          const failed = results.find((r) => !r.passed);
          throw new Error(`Validation failed: ${failed?.command}\n${failed?.stderr}`);
        }
        await this.store.update(state.ticketId, { stage: 'validated' });
        break;
      }

      case 'validated': {
        await this.workspace.commitAndPush(state.worktreeDir!, state.branch, `feat: ${state.issueTitle ?? state.ticketId}`);
        await this.github.updateItemStatus(state.ticketId, this.config.github.statusValues.inReview);
        const taskSummary = state.openspecChangeDir
          ? fs.readFileSync(path.join(state.openspecChangeDir, 'tasks.md'), 'utf-8')
          : '_No task summary available._';
        const body = publisher.buildInitialBody(state, taskSummary);
        const existingPr = await this.github.findOpenPRByHead(state.branch);
        const pr = existingPr ?? await this.github.createPR({
          title: state.issueTitle ?? `Feature Factory: ${state.ticketId}`,
          body, head: state.branch, base: baseBranch,
        });
        if (existingPr) await this.github.updatePRBody(existingPr.number, body);
        await this.store.update(state.ticketId, { stage: 'pr_opened', prNumber: pr.number, prUrl: pr.url });
        console.log(`[worker] PR #${pr.number} opened: ${pr.url}`);
        break;
      }

      case 'pr_opened': {
        const nextStage = await runReviewStage({
          config: this.config, store: this.store, runner,
          workspace: this.workspace, validator: this.validator, publisher,
          ticketId: state.ticketId, prNumber: state.prNumber!,
          branch: state.branch, worktreeDir: state.worktreeDir!,
          openspecChangeDir: state.openspecChangeDir!,
          issueTitle: state.issueTitle ?? state.ticketId,
        });
        await this.store.update(state.ticketId, { stage: nextStage });
        break;
      }

      case 'reviewed':
      case 'fixed': {
        const usage = await this.store.loadUsage(state.ticketId);
        if (state.prNumber) {
          await publisher.publishCostSummary(state.prNumber, usage);
          await publisher.addMilestone(state.prNumber, 'completed', 'Orchestrator run complete ✅');
        }
        await this.store.update(state.ticketId, { stage: 'completed' });
        if (state.worktreeDir) await this.workspace.cleanup(state.worktreeDir, state.branch);
        await this.store.unlock(state.ticketId);
        break;
      }

      default:
        throw new Error(`Unknown stage: ${state.stage}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async blockRun(state: RunState, reason: string, publisher: ReportPublisher, prNumber?: number): Promise<void> {
    await this.store.update(state.ticketId, { stage: 'blocked', blockedAtStage: state.stage, blockedReason: reason });
    await this.store.appendEvent(state.ticketId, {
      ts: new Date().toISOString(), stage: 'blocked', type: 'blocked', message: reason,
    });
    try {
      await this.github.updateItemStatus(state.ticketId, this.config.github.statusValues.blocked);
      await publisher.addBlockedComment(
        { ...state, stage: 'blocked', blockedAtStage: state.stage, blockedReason: reason },
        reason, prNumber,
      );
    } catch (ghErr) {
      console.error('[worker] Failed to update GitHub after blocking:', ghErr);
    }
    await this.store.unlock(state.ticketId);
  }

  private log(state: RunState, message: string): void {
    console.log(`[worker] ${state.ticketId.slice(-8)} | ${message}`);
    this.store
      .appendEvent(state.ticketId, { ts: new Date().toISOString(), stage: state.stage, type: 'info', message })
      .catch(() => undefined);
  }
}
