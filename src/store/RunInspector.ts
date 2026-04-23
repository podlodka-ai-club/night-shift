import * as fs from 'fs';
import * as path from 'path';
import { RunState, ImplementResult, isSuccessfulImplementResult, parseImplementResult } from '../types.js';
import { RunStore } from './RunStore.js';
import { ValidationRunner } from '../workspace/ValidationRunner.js';
import { RepoWorkspace } from '../workspace/RepoWorkspace.js';

/**
 * Read-only inspector for run artifacts and workspace state.
 *
 * Encapsulates all evidence-gathering logic that was previously inlined
 * in the Worker, so the Worker only drives the state machine.
 */
export class RunInspector {
  constructor(
    private readonly store: RunStore,
    private readonly workspace: RepoWorkspace,
  ) {}

  /** Returns true when all four core OpenSpec artifacts exist. */
  isSpecComplete(changeDir: string): boolean {
    return (
      fs.existsSync(path.join(changeDir, 'proposal.md')) &&
      fs.existsSync(path.join(changeDir, 'design.md')) &&
      fs.existsSync(path.join(changeDir, 'specs', 'main', 'spec.md')) &&
      fs.existsSync(path.join(changeDir, 'tasks.md'))
    );
  }

  hasImplementationArtifacts(ticketId: string): boolean {
    const latest = this.readLatestImplementResult(ticketId);
    return latest ? isSuccessfulImplementResult(latest) : false;
  }

  readLatestImplementResult(ticketId: string): ImplementResult | null {
    const runDir = this.store.runDir(ticketId);
    for (const fileName of ['implement-output.json', 'implement-summary.json']) {
      const filePath = path.join(runDir, fileName);
      if (!fs.existsSync(filePath)) continue;

      try {
        return parseImplementResult(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      } catch {
        continue;
      }
    }
    return null;
  }

  latestImplementAttemptFailed(ticketId: string): boolean {
    const latest = this.readLatestImplementResult(ticketId);
    return latest ? latest.completed === false : false;
  }

  hasPassingValidation(ticketId: string): boolean {
    const file = path.join(this.store.runDir(ticketId), 'validation-results.json');
    if (!fs.existsSync(file)) return false;

    try {
      const results = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<{ passed: boolean }>;
      return ValidationRunner.allPassed(results as never);
    } catch {
      return false;
    }
  }

  async worktreeHasUncommittedChanges(worktreeDir?: string): Promise<boolean> {
    if (!worktreeDir || !fs.existsSync(worktreeDir)) return false;

    try {
      return await this.workspace.hasUncommittedChanges(worktreeDir);
    } catch {
      return false;
    }
  }

  async worktreeHasChanges(worktreeDir: string | undefined, baseBranch: string): Promise<boolean> {
    if (!worktreeDir || !fs.existsSync(worktreeDir)) return false;

    try {
      if (await this.worktreeHasUncommittedChanges(worktreeDir)) {
        return true;
      }
      const diff = await this.workspace.getDiff(worktreeDir, baseBranch);
      return diff.trim().length > 0;
    } catch {
      return false;
    }
  }

  async hasImplementationProgress(state: RunState, baseBranch: string): Promise<boolean> {
    if (this.latestImplementAttemptFailed(state.ticketId)) return false;
    if (this.hasImplementationArtifacts(state.ticketId)) return true;
    return this.worktreeHasChanges(state.worktreeDir, baseBranch);
  }
}
