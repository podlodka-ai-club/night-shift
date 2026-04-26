import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BUILTIN_ADAPTER_IDS,
  isBuiltInAdapterId,
  type AgentAdapterFactory,
} from "../adapters/types.js";
import {
  DEFAULT_CONFIG,
  NightShiftConfigSchema,
  type NightShiftConfig,
  type ResolvedNightShiftConfig,
} from "./schema.js";

const CANDIDATE_FILENAMES = [
  "night-shift.config.ts",
  "night-shift.config.mts",
  "night-shift.config.mjs",
  "night-shift.config.js",
];

/**
 * Resolves the config file path following the documented precedence:
 * explicit argument > `NIGHT_SHIFT_CONFIG` env var > first matching candidate
 * under `cwd`. Returns `undefined` when no candidate exists.
 */
export function resolveConfigPath(
  explicitPath?: string,
  cwd: string = process.cwd(),
): string | undefined {
  const fromEnv = process.env.NIGHT_SHIFT_CONFIG;
  const candidate = explicitPath ?? fromEnv;
  if (candidate) {
    const resolved = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found at "${resolved}"`);
    }
    return resolved;
  }
  for (const name of CANDIDATE_FILENAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface LoadConfigOptions {
  explicitPath?: string;
  cwd?: string;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedNightShiftConfig> {
  const path = resolveConfigPath(options.explicitPath, options.cwd);
  if (!path) return NightShiftConfigSchema.parse(DEFAULT_CONFIG);

  loadAdjacentEnvFile(path);

  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const user = (mod.default ?? {}) as Partial<NightShiftConfig>;
  const merged = deepMerge(DEFAULT_CONFIG, user) as NightShiftConfig;
  const withResolvedPaths = resolveConfigRelativePaths(merged, dirname(path));
  const adapterFactories = validateAdapterFactories(withResolvedPaths.adapterFactories);
  const parsed = NightShiftConfigSchema.parse(withResolvedPaths);

  validateRoleProviders(parsed, adapterFactories);

  return {
    ...parsed,
    ...(adapterFactories ? { adapterFactories } : {}),
  };
}

function loadAdjacentEnvFile(configPath: string): void {
  const envPath = resolve(dirname(configPath), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  process.loadEnvFile(envPath);
}

function resolveConfigRelativePaths(
  config: NightShiftConfig,
  configDir: string,
): NightShiftConfig {
  if (!config.repoRoot || isAbsolute(config.repoRoot)) {
    return config;
  }

  return {
    ...config,
    repoRoot: resolve(configDir, config.repoRoot),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateAdapterFactories(
  adapterFactories: NightShiftConfig["adapterFactories"],
): Readonly<Record<string, AgentAdapterFactory>> | undefined {
  if (adapterFactories === undefined) {
    return undefined;
  }
  if (!isPlainObject(adapterFactories)) {
    throw new Error("loadConfig: adapterFactories must be an object");
  }

  const validated: Record<string, AgentAdapterFactory> = {};

  for (const [provider, factory] of Object.entries(adapterFactories)) {
    if (!provider.trim()) {
      throw new Error("loadConfig: adapterFactories keys must be non-empty strings");
    }
    if (isBuiltInAdapterId(provider)) {
      throw new Error(`loadConfig: \"${provider}\" is a reserved built-in adapter id`);
    }
    if (typeof factory !== "function") {
      throw new Error(`loadConfig: adapterFactories.${provider} must be a function`);
    }
    validated[provider] = factory as AgentAdapterFactory;
  }

  return validated;
}

function validateRoleProviders(
  config: Pick<ResolvedNightShiftConfig, "roles">,
  adapterFactories?: Readonly<Record<string, AgentAdapterFactory>>,
): void {
  const availableProviders = new Set<string>([
    ...BUILTIN_ADAPTER_IDS,
    ...Object.keys(adapterFactories ?? {}),
  ]);
  const availableList = Array.from(availableProviders).sort().join(", ");

  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig) {
      continue;
    }
    if (!availableProviders.has(roleConfig.provider)) {
      throw new Error(
        `loadConfig: roles.${role}.provider \"${roleConfig.provider}\" is not a built-in or registered adapter (available: ${availableList})`,
      );
    }
  }
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (k in out && isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
