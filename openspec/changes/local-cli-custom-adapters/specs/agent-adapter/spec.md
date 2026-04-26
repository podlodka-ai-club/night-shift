## ADDED Requirements

### Requirement: Configurable adapter registry

The system SHALL define an `AgentAdapterFactory` contract that can build an `AgentAdapter` from Night Shift runtime context. The built-in factories for `codex` and `claude-agent` SHALL always be available. `createAgent(...)` SHALL resolve `config.roles[role].provider` through a registry composed of the built-ins plus any factories declared in `config.adapterFactories`.

Custom adapter ids SHALL NOT shadow built-in ids. When adapter resolution fails, the thrown error SHALL include the missing provider id and the available adapter ids.

#### Scenario: Custom adapter is used for a role
- **GIVEN** `night-shift.config.ts` declares `adapterFactories.copilot`
- **WHEN** `createAgent(...)` is called for a role whose `provider` is `"copilot"`
- **THEN** the `copilot` factory is used to build the adapter session

#### Scenario: Built-in adapters still work without registration
- **WHEN** a role sets `provider: "codex"` and `adapterFactories` is omitted
- **THEN** `createAgent(...)` resolves the built-in Codex adapter successfully

#### Scenario: Duplicate built-in id is rejected
- **WHEN** `night-shift.config.ts` declares `adapterFactories.codex`
- **THEN** config loading fails with an error explaining that `codex` is a reserved built-in adapter id

#### Scenario: Unknown provider reports the available ids
- **WHEN** a role sets `provider: "bogus"` and there is no matching custom adapter factory
- **THEN** agent creation fails with an error that includes `"bogus"` and the adapter ids Night Shift can resolve

### Requirement: TypeScript config helper

The system SHALL export `defineNightShiftConfig(config)` for authoring `night-shift.config.ts`. The helper SHALL preserve Night Shift's full config type, including `adapterFactories`, and SHALL return the provided value unchanged at runtime.

#### Scenario: Helper accepts a custom adapter factory without casts
- **WHEN** a repository exports `defineNightShiftConfig({ adapterFactories: { copilot: createCopilotAdapter }, ... })`
- **THEN** the config type-checks without casting the custom factory through `unknown`

#### Scenario: Helper leaves runtime values untouched
- **WHEN** `night-shift.config.ts` default-exports `defineNightShiftConfig(config)`
- **THEN** `loadConfig(...)` receives the same runtime object shape as if `config` had been exported directly

## MODIFIED Requirements

### Requirement: NightShiftConfig schema and loader

The system SHALL define `NightShiftConfigSchema` for the serializable portion of the config with fields: `roles: Record<AgentRole, AgentRoleConfig>`, optional `qualityGates`, optional `adapters`, optional `github`, optional `reviewPhase`, optional `temporal`, and optional `pickup`. Each `AgentRoleConfig` SHALL have `provider: string`, `model: string`, optional `systemPromptFile: string`, and optional `providerOptions: unknown`.

`NightShiftConfig` SHALL additionally accept an optional `adapterFactories?: Record<string, AgentAdapterFactory>`. The `adapters` section SHALL continue to support built-in adapter-specific config such as `adapters.codex`, and it SHALL also allow arbitrary additional keys for custom adapter-specific config owned by the selected adapter factory.

The system SHALL provide `loadConfig(...)` that:
1. Resolves a config file in order: `explicitPath` override, then `process.env.NIGHT_SHIFT_CONFIG`, then repo-root `night-shift.config.ts` (with fallback extensions `.mts`, `.mjs`, `.js`)
2. Loads `.env` from the resolved config file's directory before importing the config module; missing `.env` files are ignored and existing process env values keep precedence
3. Imports the config file as an ES module and reads the default export
4. Merges the serializable fields with `DEFAULT_CONFIG` (all roles -> `{provider: "codex", model: "gpt-5.4"}`)
5. Validates the merged serializable fields with `NightShiftConfigSchema`
6. Validates `adapterFactories` as executable configuration and rejects custom ids that collide with built-in ids
7. Rejects configs where any `roles.*.provider` does not resolve to a built-in or registered custom adapter id
8. Returns `DEFAULT_CONFIG` unchanged when no config file is found

#### Scenario: No config file yields defaults
- **WHEN** `loadConfig(...)` is called in a repo with no `night-shift.config.*` and no env var
- **THEN** the returned config equals `DEFAULT_CONFIG` and every role has provider `"codex"` and model `"gpt-5.4"`

#### Scenario: Explicit path overrides discovery
- **WHEN** `loadConfig(...)` is called with an explicit config path
- **THEN** that file is imported and validated

#### Scenario: Adjacent `.env` is loaded before config import
- **WHEN** the resolved config file's directory contains `.env` and the config reads `process.env.GITHUB_TOKEN`
- **THEN** `loadConfig(...)` makes the `.env` value available before the config module executes

#### Scenario: Existing process env remains authoritative
- **WHEN** the parent process already defines `GITHUB_TOKEN` and the adjacent `.env` file also defines `GITHUB_TOKEN`
- **THEN** `loadConfig(...)` keeps the parent process value

#### Scenario: Partial file merges over defaults
- **WHEN** a config file sets only `roles.reviewer.model = "cheap-model"`
- **THEN** the returned config has `roles.reviewer = {provider: "codex", model: "cheap-model"}` and the other roles remain on defaults

#### Scenario: Custom adapter registration is accepted
- **WHEN** a config file declares `adapterFactories.copilot` and sets `roles.implementer.provider = "copilot"`
- **THEN** `loadConfig(...)` resolves successfully and preserves the custom adapter registration for later adapter resolution

#### Scenario: Unknown provider is rejected after registry validation
- **WHEN** a config sets `roles.specifier.provider = "bogus"` and `adapterFactories` does not include `"bogus"`
- **THEN** `loadConfig(...)` rejects with a validation error naming the unresolved provider id