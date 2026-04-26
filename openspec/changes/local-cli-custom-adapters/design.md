## Context

Night Shift already has two useful building blocks for the experience this change wants:

- The config loader already supports `night-shift.config.ts` and resolves it relative to a selected repo root.
- The phase CLIs already default `repoRoot` to `process.cwd()` when they operate on a checkout.
- The repo already documents `.env` for secrets, but that currently depends on how the CLI is launched rather than on Night Shift's own config-loading contract.

The user-facing interface is still not repo-first, though. The README frames Night Shift as something you run from the Night Shift checkout while pointing at another repository, and adapter selection is still implemented as a hardcoded switch over built-in provider ids. That means a team can technically use TypeScript config today, but they cannot use that executable config to register their own adapter in a supported way.

This change is intentionally about interface shape, not new phase behavior. The phases already consume injected dependencies; the work belongs in the CLI, config, and adapter-resolution layers.

## Goals / Non-Goals

**Goals:**
- Make the repository being automated the primary place from which users install and invoke Night Shift.
- Keep TypeScript config as the first-class customization surface and extend it to support custom adapter factories.
- Preserve backward compatibility for existing built-in adapter ids and role configuration.
- Keep the role set fixed (`specifier`, `implementer`, `reviewer`, `subagent`) while making adapter resolution extensible.

**Non-Goals:**
- Dynamic creation of new Night Shift roles.
- A plugin marketplace, remote plugin loading, or package auto-installation.
- Replacing the existing phase contracts or changing phase semantics.
- Supporting JSON or YAML as an equivalent customization mechanism for custom adapters.

## Decisions

### 1. Repo-local CLI is the primary mental model

Night Shift will be documented and shaped as a CLI that runs from the repository it automates. `process.cwd()` remains the default repo root, and `--repo-root` stays as an escape hatch when a command is launched from elsewhere.

This change adds a dedicated `night-shift init` command that scaffolds `night-shift.config.ts` into the selected repo root. The generated config becomes the user's main integration point and should make the local-repo workflow obvious without requiring them to study internal docs first.

Alternative considered: keep the existing commands and only rewrite the README. Rejected because the install story would still feel implicit, and there would be no first-run command that anchors the repo-local workflow.

### 2. Keep config executable and add a typed helper for authoring it

Custom adapters require executable configuration, so the config stays in TypeScript. The user-facing API adds a `defineNightShiftConfig(...)` helper that returns the provided config unchanged at runtime while giving the TypeScript compiler a concrete type for executable fields such as `adapterFactories`.

The generated config from `night-shift init` should use the helper and include a commented example that shows how to import and register a custom adapter.

Alternative considered: declare custom adapters by module-path strings in JSON-like config. Rejected because it adds indirection, weakens typing, and solves a problem TypeScript config already solves directly.

### 3. Replace the hardcoded provider switch with a registry

Adapter resolution moves from `switch (provider)` to a registry built from:

- built-in adapter factories for `codex` and `claude-agent`
- optional user factories declared in `config.adapterFactories`

Roles continue to reference adapters through `roles.<role>.provider` so existing configs keep working. Built-in ids are reserved and cannot be shadowed by user config. When a role references an unknown adapter id, Night Shift should fail with a descriptive error that lists the ids it does know about.

Alternative considered: keep custom adapter resolution in the CLI layer only. Rejected because worker and phase wrappers would continue to duplicate provider resolution and tests would still need to special-case built-ins versus custom adapters.

### 4. Split validation between serializable config and executable hooks

The serializable part of the config should continue to be validated with Zod. Executable fields such as `adapterFactories` should be validated with a lightweight runtime guard and then cross-checked against role assignments after merge.

This keeps the existing `DEFAULT_CONFIG` merge behavior, preserves helpful schema errors for normal config mistakes, and still lets TypeScript config carry actual factory functions.

Example target shape:

```ts
import { defineNightShiftConfig } from "night-shift/config";
import { createCopilotAdapter } from "./.night-shift/adapters/copilot";

export default defineNightShiftConfig({
  adapterFactories: {
    copilot: ({ adapterConfig }) => createCopilotAdapter(adapterConfig),
  },
  adapters: {
    copilot: { mode: "workspace-write" },
  },
  roles: {
    implementer: { provider: "copilot", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4-mini" },
  },
});
```

Alternative considered: require every custom adapter to be serialized as plain data and loaded later by name. Rejected because the project already chose TypeScript config specifically to avoid that restriction.

### 5. Auto-load `.env` before importing TypeScript config

Night Shift should automatically load a `.env` file adjacent to the resolved `night-shift.config.*` file before importing that config module. A missing `.env` file is not an error. Existing environment variables supplied by the parent shell or process must keep precedence over entries from `.env`.

This makes the repo-local CLI behave consistently whether the user runs it through `npm run ...` or through an installed `night-shift` binary, and it ensures the generated config template can safely use `process.env` for secrets.

Alternative considered: rely only on package-manager scripts with Node's `--env-file` flags. Rejected because direct CLI invocations would behave differently, and the initialized config template would fail unless the user remembered to wrap every command the same way.

### 6. Generated config is env-first for secrets

The `night-shift init` template should use `process.env` lookups for secret-bearing fields such as GitHub tokens and app credentials, and it should include an inline comment telling the user to define those variables in `.env` for local use.

Alternative considered: write placeholder secret strings directly into the generated config. Rejected because it normalizes putting secrets into a committed TypeScript file and works against the repo-local setup the change is trying to encourage.

### 7. Package the CLI as a private dependency with a real binary

The first supported distribution model should be: install Night Shift into the target repository as a private Git dependency, expose a real `night-shift` package binary, and invoke it with `npm exec`. This keeps the tool private while still making it accessible both from the target repository and from other folders via `npm exec --prefix <repo-root>`.

This decision separates packaging from config resolution cleanly:

- packaging answers how the process is found
- repo-root selection answers which repository Night Shift operates on

That avoids making global installation part of the core UX and keeps the target repository in control of the Night Shift version it uses.

Alternative considered: rely on `npm link` or global install as the main access model. Rejected because it creates version drift across machines and weakens repo-level reproducibility.

## Risks / Trade-offs

- **[Executable config runs repo code]** -> This is already true for `night-shift.config.ts`; the mitigation is to keep config loading explicit and document that Night Shift trusts the local repository.
- **[More user-facing surface area]** -> `night-shift init` and `defineNightShiftConfig` add API surface, but they reduce ambiguity in the first-run experience and avoid undocumented patterns.
- **[Registry collisions]** -> Custom ids can conflict with built-ins; reserve built-in ids and fail fast during config load.
- **[Opaque adapter-specific config]** -> `adapters.<id>` becomes extensible, which weakens schema-level guarantees for custom adapters. The mitigation is to keep built-in adapter config typed while treating custom slices as adapter-owned contracts.
- **[Unexpected `.env` contents]** -> Auto-loading `.env` widens what can influence config import. The mitigation is to load only the `.env` adjacent to the resolved config file, ignore missing files, and keep explicit process env values authoritative.
- **[Private Git dependency installs are slower]** -> Git-based package installs are heavier than registry installs. The mitigation is to keep the invocation model (`npm exec night-shift`) stable so the project can move to a private registry later without changing user commands.

## Open Questions

- Should the first version of `night-shift init` only scaffold `night-shift.config.ts`, or should it also generate an optional local adapter stub under `.night-shift/adapters/`? The interface does not require the stub, so implementation can start with config scaffolding only.