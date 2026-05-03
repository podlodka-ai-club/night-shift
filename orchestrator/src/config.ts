import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BACKLOG_STATUS,
  DEFAULT_BLOCKED_STATUS,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_ESCALATED_STATUS,
  DEFAULT_IN_REVIEW_STATUS,
  DEFAULT_READY_STATUS,
  TASK_QUEUE,
} from './shared';
import {
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  ESCALATION_CODEX_MODEL,
  ESCALATION_CODEX_REASONING_EFFORT,
  type AgentReasoningEffort,
} from './activity-deps';
import { z } from 'zod';

const agentProfileSchema = z.object({
  model: z.string(),
  reasoningEffort: z.enum(['low', 'medium', 'high'] satisfies [AgentReasoningEffort, ...AgentReasoningEffort[]]),
});

const runtimeRequire = createRequire(__filename);

const CONFIG_FILENAMES = [
  'orchestrator.config.ts',
  'orchestrator.config.js',
  'orchestrator.config.mjs',
  'night-shift.config.ts',
  'night-shift.config.js',
  'night-shift.config.mjs',
] as const;

const orchestratorConfigSchema = z.object({
  temporal: z.object({
    address: z.string().default('localhost:7233'),
    namespace: z.string().default('default'),
    taskQueue: z.string().default(TASK_QUEUE),
  }).default({ address: 'localhost:7233', namespace: 'default', taskQueue: TASK_QUEUE }),
  intake: z.object({
    maxActions: z.number().int().positive().default(1),
  }).default({ maxActions: 1 }),
  pickup: z.object({
    enabled: z.boolean().default(true),
    intervalSeconds: z.number().int().positive().default(10),
    maxConcurrent: z.number().int().positive().default(5),
  }).default({ enabled: true, intervalSeconds: 10, maxConcurrent: 5 }),
  agentProfiles: z.object({
    default: agentProfileSchema.default({ model: CODEX_MODEL, reasoningEffort: CODEX_REASONING_EFFORT }),
    escalation: agentProfileSchema.default({ model: ESCALATION_CODEX_MODEL, reasoningEffort: ESCALATION_CODEX_REASONING_EFFORT }),
  }).default({
    default: { model: CODEX_MODEL, reasoningEffort: CODEX_REASONING_EFFORT },
    escalation: { model: ESCALATION_CODEX_MODEL, reasoningEffort: ESCALATION_CODEX_REASONING_EFFORT },
  }),
  github: z.object({
    projectOwner: z.string().optional(),
    projectNumber: z.number().int().positive().optional(),
    backlogStatusName: z.string().default(DEFAULT_BACKLOG_STATUS),
    readyStatusName: z.string().default(DEFAULT_READY_STATUS),
    inReviewStatusName: z.string().default(DEFAULT_IN_REVIEW_STATUS),
    escalatedStatusName: z.string().default(DEFAULT_ESCALATED_STATUS),
    blockedStatusName: z.string().default(DEFAULT_BLOCKED_STATUS),
    branchPrefix: z.string().default(DEFAULT_BRANCH_PREFIX),
  }).default({
    backlogStatusName: DEFAULT_BACKLOG_STATUS,
    readyStatusName: DEFAULT_READY_STATUS,
    inReviewStatusName: DEFAULT_IN_REVIEW_STATUS,
    escalatedStatusName: DEFAULT_ESCALATED_STATUS,
    blockedStatusName: DEFAULT_BLOCKED_STATUS,
    branchPrefix: DEFAULT_BRANCH_PREFIX,
  }),
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type OrchestratorConfigInput = z.input<typeof orchestratorConfigSchema>;

export interface LoadOrchestratorConfigOptions {
  explicitPath?: string;
  cwd?: string;
}

export function defineOrchestratorConfig<T extends OrchestratorConfigInput>(config: T): T {
  return config;
}

export function resolveOrchestratorConfigPath(options: LoadOrchestratorConfigOptions = {}): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const candidate = options.explicitPath ?? process.env.ORCHESTRATOR_CONFIG ?? process.env.NIGHT_SHIFT_CONFIG;
  if (candidate) {
    const resolvedPath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Config file not found at "${resolvedPath}"`);
    }
    return resolvedPath;
  }

  const parentDirectory = path.dirname(cwd);
  const candidateDirectories = cwd === parentDirectory ? [cwd] : [cwd, parentDirectory];
  for (const directory of candidateDirectories) {
    for (const filename of CONFIG_FILENAMES) {
      const resolvedPath = path.resolve(directory, filename);
      if (existsSync(resolvedPath)) {
        return resolvedPath;
      }
    }
  }

  return undefined;
}

export async function loadOrchestratorConfig(options: LoadOrchestratorConfigOptions = {}): Promise<OrchestratorConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveOrchestratorConfigPath(options);
  if (!configPath) {
    loadEnvFileIfPresent(path.resolve(cwd, '.env'));
    return orchestratorConfigSchema.parse({});
  }

  loadEnvFileIfPresent(path.resolve(path.dirname(configPath), '.env'));
  const loaded = await loadConfigModule(configPath);
  return orchestratorConfigSchema.parse(loaded ?? {});
}

async function loadConfigModule(configPath: string): Promise<unknown> {
  if (configPath.endsWith('.mjs')) {
    const loaded = await import(pathToFileUrl(configPath));
    return loaded.default ?? loaded;
  }
  delete runtimeRequire.cache[runtimeRequire.resolve(configPath)];
  const loaded = runtimeRequire(configPath) as { default?: unknown } | unknown;
  return typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded;
}

function loadEnvFileIfPresent(envPath: string): void {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function pathToFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}