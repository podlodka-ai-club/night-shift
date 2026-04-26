# `src/config/`

Loads the user-level Night Shift configuration and provides the
`NightShiftConfigSchema` used to validate it.

## Shape

```ts
type NightShiftConfig = {
  roles: Record<AgentRole, AgentRoleConfig>;
  adapterFactories?: Record<string, AgentAdapterFactory>;
  qualityGates?: Record<string, unknown>;
  adapters?: Record<string, unknown> & { codex?: Record<string, unknown> };
  github?: GitHubConfig;
};

type AgentRoleConfig = {
  provider: string;
  model: string;
  systemPromptFile?: string;  // resolved relative to cwd
  skills?: string[];          // optional provider-native skill ids
  providerOptions?: unknown;  // opaque passthrough
};
```

The role keys are `specifier`, `implementer`, `reviewer`, `subagent`.

Use `defineNightShiftConfig(...)` from `night-shift/config` when authoring
`night-shift.config.ts` so TypeScript understands executable fields like
`adapterFactories`.

## Discovery order

`loadConfig({ explicitPath? })` resolves the config path in this order:

1. `explicitPath` argument, if provided.
2. The `NIGHT_SHIFT_CONFIG` environment variable, if set.
3. The first file that exists under `process.cwd()` matching
   `night-shift.config.{ts,mts,mjs,js}`.

If nothing is found, `DEFAULT_CONFIG` is returned (every role uses Codex +
`gpt-5.4`).

Before importing the resolved config module, Night Shift auto-loads `.env`
from the same directory when it exists. Existing environment variables from
the parent shell keep precedence over `.env` values.

## Merging

The user's config is **deep-merged** into `DEFAULT_CONFIG` so partial configs
work (e.g. only overriding the reviewer's model). The serializable portion of
the merged result is then validated with `NightShiftConfigSchema.parse`, and
`adapterFactories` is validated separately as executable configuration.

Custom adapter ids cannot shadow built-in ids such as `codex` and
`claude-agent`.

## Example

See [`night-shift.config.example.ts`](../../night-shift.config.example.ts) for
a populated example.

Minimal pattern:

```ts
import { defineNightShiftConfig } from "night-shift/config";

export default defineNightShiftConfig({
  roles: {
    implementer: {
      provider: "codex",
      model: "gpt-5.4",
      skills: ["openspec-apply-change", "openspec-explore"],
    },
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_REPO_OWNER ?? "your-username",
    repo: process.env.GITHUB_REPO_NAME ?? "your-repo",
    projectOwner: process.env.GITHUB_PROJECT_OWNER ?? "your-org",
    projectOwnerType: "org",
    projectNumber: 1,
  },
});
```

`roles.<role>.skills` is an optional list of provider-native skill ids Night
Shift passes through to the adapter at session-open time. This is the config
surface for enabling OpenSpec-oriented skills such as
`openspec-propose`, `openspec-apply-change`, and `openspec-explore` when the
selected provider supports them.

## Module boundary

`src/config/**` may import from `src/contracts/**`, `src/adapters/**`,
`src/github/**` (for `GitHubConfigSchema` only), `zod`, `node:fs`,
`node:path`, `node:url`, and its own siblings. It MUST NOT be imported (at
runtime) by anything under `src/adapters/`.

## `github` section

The optional `github` field is a `GitHubConfigSchema` (see
[`src/github/README.md`](../github/README.md)). It configures the GitHub
App credentials, target repo, and Projects v2 node id that
`createGitHubClient` uses at runtime. Leave it unset to run with the
in-memory fake during local development.

## Repo-local CLI

When using the packaged CLI, Night Shift treats the current working directory
as the selected repo root by default. Pass `--repo-root <path>` to any CLI
command when you want config discovery and repo-relative behavior to target a
different checkout.
