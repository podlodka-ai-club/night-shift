import path from "node:path";
import crypto from "node:crypto";
import { createConfiguredAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/events.js";
import type { AgentRole } from "../adapters/types.js";
import { loadConfig } from "../config/loader.js";
import type { NightShiftConfig, ResolvedNightShiftConfig } from "../config/schema.js";

export interface RepoLocalOptions {
  explicitPath?: string;
  repoRoot?: string;
  cwd?: string;
}

export function resolveSelectedRepoRoot(
  repoRoot?: string,
  cwd: string = process.cwd(),
): string {
  return path.resolve(cwd, repoRoot ?? ".");
}

export function buildRepoScopedTaskQueue(baseTaskQueue: string, repoRoot: string): string {
  const digest = crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
  return `${baseTaskQueue}-${digest}`;
}

export function applyRepoLocalConfigIsolation(
  config: ResolvedNightShiftConfig,
  repoRoot: string,
): ResolvedNightShiftConfig {
  return {
    ...config,
    temporal: {
      ...config.temporal,
      taskQueue: buildRepoScopedTaskQueue(config.temporal.taskQueue, repoRoot),
    },
  };
}

export async function loadRepoLocalConfig(
  options: RepoLocalOptions = {},
): Promise<{ config: ResolvedNightShiftConfig; repoRoot: string }> {
  const repoRoot = resolveSelectedRepoRoot(options.repoRoot, options.cwd);
  const config = await loadConfig({
    ...(options.explicitPath !== undefined ? { explicitPath: options.explicitPath } : {}),
    cwd: repoRoot,
  });

  return { config: applyRepoLocalConfigIsolation(config, repoRoot), repoRoot };
}

export function createRoleAdapter(
  config: Pick<NightShiftConfig, "roles" | "adapterFactories" | "adapters">,
  role: AgentRole,
): AgentAdapter {
  const roleConfig = config.roles[role];
  if (!roleConfig) {
    throw new Error(`config.roles.${role} is not defined`);
  }

  return createConfiguredAdapter(roleConfig.provider, config);
}