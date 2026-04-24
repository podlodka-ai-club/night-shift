import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CONFIG,
  NightShiftConfigSchema,
  type NightShiftConfig,
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
): Promise<NightShiftConfig> {
  const path = resolveConfigPath(options.explicitPath, options.cwd);
  if (!path) return NightShiftConfigSchema.parse(DEFAULT_CONFIG);

  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const user = (mod.default ?? {}) as Partial<NightShiftConfig>;
  const merged = deepMerge(DEFAULT_CONFIG, user) as NightShiftConfig;
  return NightShiftConfigSchema.parse(merged);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
