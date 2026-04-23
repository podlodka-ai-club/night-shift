import { Config } from '../config.js';
import { RunStore } from '../store/RunStore.js';
import { AgentRunner } from '../providers/AgentRunner.js';
import { RepoWorkspace } from '../workspace/RepoWorkspace.js';
import { ValidationRunner } from '../workspace/ValidationRunner.js';
import { ReportPublisher } from '../github/ReportPublisher.js';

/**
 * Shared context passed to every stage handler.
 *
 * Stages destructure only what they need. This replaces the per-stage
 * `*Ctx` interfaces that previously required manual assembly in the
 * Worker's step() switch.
 */
export interface StageContext {
  config: Config;
  store: RunStore;
  runner: AgentRunner;
  workspace: RepoWorkspace;
  validator: ValidationRunner;
  publisher: ReportPublisher;

  // Per-run identifiers
  ticketId: string;
  branch: string;
  worktreeDir: string;
  openspecChangeDir: string;
  issueTitle: string;
  issueBody: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
}
