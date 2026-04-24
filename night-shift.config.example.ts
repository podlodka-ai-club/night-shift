import type { NightShiftConfig } from "./src/config/schema.js";

/**
 * Example Night Shift configuration. Copy to `night-shift.config.ts` (or
 * `.mjs`/`.mts`/`.js`) at the repo root and adjust to your needs.
 *
 * Discovery order:
 *   1. Explicit path passed to `loadConfig({ explicitPath })`
 *   2. `NIGHT_SHIFT_CONFIG` environment variable
 *   3. First matching `night-shift.config.{ts,mts,mjs,js}` under the cwd
 *
 * Any role left unset falls back to `DEFAULT_CONFIG` (Codex + gpt-5.4).
 */
const config: NightShiftConfig = {
  roles: {
    specifier: {
      provider: "codex",
      model: "gpt-5.4",
      systemPromptFile: "prompts/specifier.md",
    },
    implementer: {
      provider: "codex",
      model: "gpt-5.4",
      systemPromptFile: "prompts/implementer.md",
    },
    // The reviewer runs often and gets a lot of context; prefer a cheaper
    // model here and rely on the quality-gate findings for correctness.
    reviewer: {
      provider: "codex",
      model: "gpt-5.4-mini",
      systemPromptFile: "prompts/reviewer.md",
    },
    subagent: {
      provider: "codex",
      model: "gpt-5.4-mini",
    },
  },
  qualityGates: {
    typecheck: true,
    lint: true,
    test: true,
  },
};

export default config;
