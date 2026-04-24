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
  // Optional: enable real GitHub integration. Omit this block to run
  // with the in-memory fake (see `src/github/fake.ts`).
  github: {
    appId: 123456,
    installationId: 7890123,
    // Provide EXACTLY ONE of privateKey or privateKeyPath.
    privateKeyPath: "./.secrets/night-shift.pem",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "change-me",
    owner: "acme",
    repo: "widgets",
    projectNodeId: "PVT_kwDOABC123",
    // Defaults:
    // statusFieldName: "Status",
    // manageStatusOptions: true,
  },
};

export default config;
