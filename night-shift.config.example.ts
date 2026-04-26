import { defineNightShiftConfig } from "night-shift/config";

/**
 * Example Night Shift configuration for a target repository that installs
 * Night Shift as a private dependency.
 *
 * Discovery order:
 *   1. Explicit path passed to `loadConfig({ explicitPath })`
 *   2. `NIGHT_SHIFT_CONFIG` environment variable
 *   3. First matching `night-shift.config.{ts,mts,mjs,js}` under the cwd
 *
 * Night Shift auto-loads `.env` next to this file before importing it, so
 * `process.env.*` lookups are available during config evaluation.
 *
 * Any role left unset falls back to `DEFAULT_CONFIG` (Codex + gpt-5.4).
 */
export default defineNightShiftConfig({
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
  // Local setup: put these values in `.env` next to this config file.
  //
  // Auth: provide `token` (PAT, simplest) or App credentials (appId + installationId + privateKeyPath).
  // Project: provide `projectNodeId` directly, or `projectNumber` + `projectOwner` + `projectOwnerType`
  //          to resolve it automatically at startup.
  //
  // Tests use an in-memory fake automatically (see `src/github/__test__/fake.ts`).
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_REPO_OWNER ?? "your-username",
    repo: process.env.GITHUB_REPO_NAME ?? "your-repo",
    projectOwner: process.env.GITHUB_PROJECT_OWNER ?? "your-username-or-org",
    projectOwnerType: (process.env.GITHUB_PROJECT_OWNER_TYPE as "user" | "org") ?? "user",
    projectNumber: Number(process.env.GITHUB_PROJECT_NUMBER ?? "1"),
    // Or provide projectNodeId directly (skips the lookup):
    // projectNodeId: "PVT_kwDOABC123",
  },
  // Optional: Auto-pickup from the board. When enabled, a cron workflow
  // periodically scans Backlog + Ready columns and starts ticket workflows.
  pickup: {
    enabled: true,
    intervalMinutes: 5, // must evenly divide 60
    maxConcurrent: 5,
  },
  // Optional: Temporal server connection. Defaults shown below.
  temporal: {
    serverUrl: "localhost:7233",
    namespace: "default",
    taskQueue: "night-shift",
  },
  // Example custom adapter registration:
  // adapterFactories: {
  //   copilot: ({ adapterConfig }) => createCopilotAdapter(adapterConfig),
  // },
  // adapters: {
  //   copilot: { mode: "workspace-write" },
  // },
});
