# `src/config/`

Loads the user-level Night Shift configuration and provides the
`NightShiftConfigSchema` used to validate it.

## Shape

```ts
type NightShiftConfig = {
  roles: Record<AgentRole, AgentRoleConfig>;
  qualityGates?: Record<string, unknown>;
  adapters?: { codex?: Record<string, unknown> };
};

type AgentRoleConfig = {
  provider: "codex" | "claude-agent";
  model: string;
  systemPromptFile?: string;  // resolved relative to cwd
  providerOptions?: unknown;  // opaque passthrough
};
```

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
`zod`, `node:fs`, `node:path`, `node:url`, and its own siblings. It MUST NOT
be imported (at runtime) by anything under `src/adapters/`.
