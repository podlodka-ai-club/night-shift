import { loadOrchestratorConfig, type LoadOrchestratorConfigOptions, type OrchestratorConfig } from './config';
import type { AutomateReadyIssueInput, ProjectStatusName } from './shared';

export type IntakeCommand =
  | { kind: 'pickup'; maxActions: number }
  | { kind: 'manual'; statusName: ProjectStatusName };

export interface ResolvedTemporalEntrypointConfig {
  address: string;
  namespace: string;
  taskQueue: string;
}

export interface ResolvedPickupConfig {
  enabled: boolean;
  intervalSeconds: number;
  maxConcurrent: number;
}

export interface LoadClientEntrypointConfigOptions extends LoadOrchestratorConfigOptions {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface LoadWorkerEntrypointConfigOptions extends LoadOrchestratorConfigOptions {
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedClientEntrypointConfig {
  temporal: ResolvedTemporalEntrypointConfig;
  workflowInput: AutomateReadyIssueInput;
  command: IntakeCommand;
}

export interface ResolvedWorkerEntrypointConfig {
  temporal: ResolvedTemporalEntrypointConfig;
  workflowInput: AutomateReadyIssueInput;
  pickup: ResolvedPickupConfig;
}

export interface ParsedEntrypointConfigArgs {
  explicitPath?: string;
  args: string[];
}

export function parseEntrypointConfigArgs(args: string[]): ParsedEntrypointConfigArgs {
  const remainingArgs: string[] = [];
  let explicitPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      explicitPath = args[index + 1];
      if (!explicitPath) {
        throw new Error('Missing value for --config');
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      explicitPath = arg.slice('--config='.length);
      if (!explicitPath) {
        throw new Error('Missing value for --config');
      }
      continue;
    }

    remainingArgs.push(arg);
  }

  return { explicitPath, args: remainingArgs };
}

export async function loadClientEntrypointConfig(
  options: LoadClientEntrypointConfigOptions,
): Promise<ResolvedClientEntrypointConfig> {
  const env = options.env ?? process.env;
  const config = await loadOrchestratorConfig(options);
  const [projectOwnerArg, projectNumberArg, modeOrStatusArg, maxActionsArg] = options.args;
  const projectOwner = projectOwnerArg ?? env.GITHUB_PROJECT_OWNER ?? config.github.projectOwner;
  const projectNumberRaw = projectNumberArg ?? env.GITHUB_PROJECT_NUMBER ?? optionalNumberToString(config.github.projectNumber);

  if (!projectOwner || !projectNumberRaw) {
    throw new Error(
      'Usage: npm run workflow -- <project-owner> <project-number> [pickup|Backlog|Ready|"In review"] [max-actions]',
    );
  }

  const workflowInput = resolveWorkflowInput(env, config, projectOwner, projectNumberRaw);

  if (!modeOrStatusArg || modeOrStatusArg === 'pickup') {
    const maxActionsRaw = maxActionsArg ?? env.GITHUB_PICKUP_MAX_ACTIONS ?? String(config.intake.maxActions);
    const maxActions = Number(maxActionsRaw);
    if (!Number.isInteger(maxActions) || maxActions <= 0) {
      throw new Error(`Invalid pickup max-actions value: ${maxActionsRaw}`);
    }
    return { temporal: resolveTemporalEntrypointConfig(env, config), workflowInput, command: { kind: 'pickup', maxActions } };
  }

  if (isManualStatus(modeOrStatusArg)) {
    return { temporal: resolveTemporalEntrypointConfig(env, config), workflowInput, command: { kind: 'manual', statusName: modeOrStatusArg } };
  }

  throw new Error(`Unsupported intake mode or status: ${modeOrStatusArg}`);
}

export async function loadWorkerEntrypointConfig(
  options: LoadWorkerEntrypointConfigOptions = {},
): Promise<ResolvedWorkerEntrypointConfig> {
  const env = options.env ?? process.env;
  const config = await loadOrchestratorConfig(options);
  const projectOwner = env.GITHUB_PROJECT_OWNER ?? config.github.projectOwner;
  const projectNumberRaw = env.GITHUB_PROJECT_NUMBER ?? optionalNumberToString(config.github.projectNumber);
  if (!projectOwner || !projectNumberRaw) {
    throw new Error('Worker requires github.projectOwner and github.projectNumber so scheduled pickup can start workflows.');
  }
  return {
    temporal: resolveTemporalEntrypointConfig(env, config),
    workflowInput: resolveWorkflowInput(env, config, projectOwner, projectNumberRaw),
    pickup: {
      enabled: config.pickup.enabled,
      intervalSeconds: config.pickup.intervalSeconds,
      maxConcurrent: config.pickup.maxConcurrent,
    },
  };
}

function resolveTemporalEntrypointConfig(env: NodeJS.ProcessEnv, config: OrchestratorConfig): ResolvedTemporalEntrypointConfig {
  return {
    address: env.TEMPORAL_ADDRESS ?? config.temporal.address,
    namespace: env.TEMPORAL_NAMESPACE ?? config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
  };
}

function resolveWorkflowInput(
  env: NodeJS.ProcessEnv,
  config: OrchestratorConfig,
  projectOwner: string,
  projectNumberRaw: string,
): AutomateReadyIssueInput {
  const projectNumber = Number(projectNumberRaw);
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(`Invalid project number: ${projectNumberRaw}`);
  }

  return {
    projectOwner,
    projectNumber,
    backlogStatusName: env.GITHUB_BACKLOG_STATUS ?? config.github.backlogStatusName,
    readyStatusName: env.GITHUB_READY_STATUS ?? config.github.readyStatusName,
    inReviewStatusName: env.GITHUB_IN_REVIEW_STATUS ?? config.github.inReviewStatusName,
    blockedStatusName: env.GITHUB_BLOCKED_STATUS ?? config.github.blockedStatusName,
    branchPrefix: env.GITHUB_BRANCH_PREFIX ?? config.github.branchPrefix,
  };
}

function optionalNumberToString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function isManualStatus(value: string): value is ProjectStatusName {
  return value === 'Backlog' || value === 'Ready' || value === 'In review';
}