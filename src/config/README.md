# `src/config/`

Loads the user-level Night Shift configuration and provides the
`NightShiftConfigSchema` used to validate it.

## Shape

```ts
type NightShiftConfig = {
  roles: Record<AgentRole, AgentRoleConfig>;
  repoRoot?: string;
  qualityGates?: Record<string, unknown>;
  adapters?: { codex?: Record<string, unknown> };
  github?: GitHubConfig;
};

type AgentRoleConfig = {
  provider: "codex" | "claude-agent";
  model: string;
  systemPromptFile?: string;  // resolved relative to cwd
  providerOptions?: unknown;  // opaque passthrough
};
```

`repoRoot`, when set, selects the local checkout Night Shift should read,
modify, and validate. Relative `repoRoot` values are resolved from the config
file's directory.

The role keys are `specifier`, `implementer`, `reviewer`, `subagent`.

## Discovery order

`loadConfig({ explicitPath? })` resolves the config path in this order:

1. `explicitPath` argument, if provided.
2. The `NIGHT_SHIFT_CONFIG` environment variable, if set.
3. The first file that exists under `process.cwd()` matching
   `night-shift.config.{ts,mts,mjs,js}`.

If nothing is found, `DEFAULT_CONFIG` is returned (every role uses Codex +
`gpt-5.4`).

## Merging

The user's config is **deep-merged** into `DEFAULT_CONFIG` so partial configs
work (e.g. only overriding the reviewer's model). The merged result is then
validated with `NightShiftConfigSchema.parse`.

## Example

See [`night-shift.config.example.ts`](../../night-shift.config.example.ts) for
a populated example.

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
