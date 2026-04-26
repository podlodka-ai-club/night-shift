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

const env = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env ?? {};

export default defineNightShiftConfig({
  roles: {
    implementer: {
      provider: "codex",
      model: "gpt-5.4",
    },
  },
  github: {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_REPO_OWNER ?? "your-username",
    repo: env.GITHUB_REPO_NAME ?? "your-repo",
    projectOwner: env.GITHUB_PROJECT_OWNER ?? "your-org",
    projectOwnerType: "org",
    projectNumber: 1,
  },
});
```

Using a local `env` binding like this keeps `night-shift.config.ts` type-safe
in repositories that do not include Node global typings.

Repo-local agent behavior should come from what the provider automatically
discovers in the repository, such as project instructions or OpenSpec setup,
rather than from a `skills` list in Night Shift config.

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
For repo-local CLI commands, Night Shift also derives a repo-scoped Temporal
task queue from `temporal.taskQueue` and the selected repo root. This keeps
workers and workflow starters from different local checkouts from polling the
same queue by accident. The worker CLI also acquires a lock under
`.night-shift/locks/` inside the selected repo root so only one worker process
can poll a given repo-scoped queue at a time.
