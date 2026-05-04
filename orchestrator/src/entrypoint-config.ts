import {
  loadOrchestratorConfig,
  type LoadOrchestratorConfigOptions,
  type OrchestratorConfig,
  type OrchestratorTarget,
} from './config';
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

export interface ResolvedEntrypointTarget {
  id: string;
  projectOwner: string;
  projectNumber: number;
  repoOwner: string;
  repoName: string;
  backlogStatusName: string;
  readyStatusName: string;
  inReviewStatusName: string;
  escalatedStatusName: string;
  blockedStatusName: string;
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
  agentProfiles: OrchestratorConfig['agentProfiles'];
}

export interface ParsedEntrypointConfigArgs {
  explicitPath?: string;
  args: string[];
}

interface ParsedClientWorkflowArgs {
  projectOwnerArg?: string;
  projectNumberArg?: string;
  modeOrStatusArg?: string;
  maxActionsArg?: string;
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
  const { projectOwnerArg, projectNumberArg, modeOrStatusArg, maxActionsArg } = parseClientWorkflowArgs(options.args);
  const target = resolveConfiguredTarget(config, env, projectOwnerArg, projectNumberArg);
  const workflowInput = resolveWorkflowInput(env, config, {
    target,
    projectOwnerArg,
    projectNumberArg,
    missingCoordinatesError: 'Usage: npm run workflow -- <project-owner> <project-number> [pickup|Backlog|Ready|"In review"|Escalated] [max-actions]',
  });

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
  const target = resolveConfiguredTarget(config, env);
  return {
    temporal: resolveTemporalEntrypointConfig(env, config),
    workflowInput: resolveWorkflowInput(env, config, {
      target,
      missingCoordinatesError: 'Worker requires github.projectOwner and github.projectNumber so scheduled pickup can start workflows.',
    }),
    pickup: {
      enabled: config.pickup.enabled,
      intervalSeconds: config.pickup.intervalSeconds,
      maxConcurrent: config.pickup.maxConcurrent,
    },
    agentProfiles: config.agentProfiles,
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
  options: {
    target?: ResolvedEntrypointTarget;
    projectOwnerArg?: string;
    projectNumberArg?: string;
    missingCoordinatesError: string;
  },
): AutomateReadyIssueInput {
  if (options.target) {
    return {
      targetId: options.target.id,
      projectOwner: options.target.projectOwner,
      projectNumber: options.target.projectNumber,
      expectedRepoOwner: options.target.repoOwner,
      expectedRepoName: options.target.repoName,
      backlogStatusName: env.GITHUB_BACKLOG_STATUS ?? options.target.backlogStatusName,
      readyStatusName: env.GITHUB_READY_STATUS ?? options.target.readyStatusName,
      inReviewStatusName: env.GITHUB_IN_REVIEW_STATUS ?? options.target.inReviewStatusName,
      escalatedStatusName: env.GITHUB_ESCALATED_STATUS ?? options.target.escalatedStatusName,
      blockedStatusName: env.GITHUB_BLOCKED_STATUS ?? options.target.blockedStatusName,
      branchPrefix: env.GITHUB_BRANCH_PREFIX ?? config.git.branchPrefix,
    };
  }

  const projectOwner = options.projectOwnerArg ?? env.GITHUB_PROJECT_OWNER ?? config.github.projectOwner;
  const projectNumberRaw = options.projectNumberArg ?? env.GITHUB_PROJECT_NUMBER ?? optionalNumberToString(config.github.projectNumber);
  if (!projectOwner || !projectNumberRaw) {
    throw new Error(options.missingCoordinatesError);
  }

  return {
    projectOwner,
    projectNumber: parseProjectNumber(projectNumberRaw),
    backlogStatusName: env.GITHUB_BACKLOG_STATUS ?? config.github.backlogStatusName,
    readyStatusName: env.GITHUB_READY_STATUS ?? config.github.readyStatusName,
    inReviewStatusName: env.GITHUB_IN_REVIEW_STATUS ?? config.github.inReviewStatusName,
    escalatedStatusName: env.GITHUB_ESCALATED_STATUS ?? config.github.escalatedStatusName,
    blockedStatusName: env.GITHUB_BLOCKED_STATUS ?? config.github.blockedStatusName,
    branchPrefix: env.GITHUB_BRANCH_PREFIX ?? config.github.branchPrefix,
  };
}

function resolveConfiguredTarget(
  config: OrchestratorConfig,
  env: NodeJS.ProcessEnv,
  projectOwnerArg?: string,
  projectNumberArg?: string,
): ResolvedEntrypointTarget | undefined {
  if (config.targets.length === 0) {
    return undefined;
  }

  const selectorOwner = projectOwnerArg ?? env.GITHUB_PROJECT_OWNER;
  const selectorProjectNumber = projectNumberArg ?? env.GITHUB_PROJECT_NUMBER;

  if (selectorOwner || selectorProjectNumber) {
    if (!selectorOwner || !selectorProjectNumber) {
      throw new Error('GitHub Project target selection requires both project owner and project number.');
    }
    const projectNumber = parseProjectNumber(selectorProjectNumber);
    const matches = config.targets.filter((target) => (
      target.project.owner === selectorOwner && target.project.number === projectNumber
    ));
    if (matches.length === 1) {
      return normalizeTarget(matches[0]);
    }
    if (matches.length > 1) {
      throw new Error(
        `GitHub Project ${selectorOwner}/${projectNumber} matches multiple configured targets: ${matches.map((target) => target.id).join(', ')}`,
      );
    }
    throw new Error(`No configured target matches GitHub Project ${selectorOwner}/${projectNumber}.`);
  }

  if (config.targets.length === 1) {
    return normalizeTarget(config.targets[0]);
  }
  throw new Error('Multiple configured targets exist; provide GitHub Project owner/number via CLI or env to select one.');
}

function isManualStatus(value: string): value is ProjectStatusName {
  return value === 'Backlog' || value === 'Ready' || value === 'In review' || value === 'Escalated';
}

function isIntakeModeOrStatus(value: string): value is 'pickup' | ProjectStatusName {
  return value === 'pickup' || isManualStatus(value);
}

function parseClientWorkflowArgs(args: string[]): ParsedClientWorkflowArgs {
  const [firstArg, secondArg, thirdArg, fourthArg] = args;
  if (firstArg && !isIntakeModeOrStatus(firstArg) && secondArg && isValidPositiveInteger(secondArg)) {
    return {
      projectOwnerArg: firstArg,
      projectNumberArg: secondArg,
      modeOrStatusArg: thirdArg,
      maxActionsArg: fourthArg,
    };
  }
  return {
    modeOrStatusArg: firstArg,
    maxActionsArg: secondArg,
  };
}

function normalizeTarget(target: OrchestratorTarget): ResolvedEntrypointTarget {
  return {
    id: target.id,
    projectOwner: target.project.owner,
    projectNumber: target.project.number,
    repoOwner: target.repo.owner,
    repoName: target.repo.name,
    backlogStatusName: target.project.backlogStatusName,
    readyStatusName: target.project.readyStatusName,
    inReviewStatusName: target.project.inReviewStatusName,
    escalatedStatusName: target.project.escalatedStatusName,
    blockedStatusName: target.project.blockedStatusName,
  };
}

function parseProjectNumber(value: string): number {
  const projectNumber = Number(value);
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(`Invalid project number: ${value}`);
  }
  return projectNumber;
}

function isValidPositiveInteger(value: string): boolean {
  return /^([1-9][0-9]*)$/.test(value);
}

function optionalNumberToString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}